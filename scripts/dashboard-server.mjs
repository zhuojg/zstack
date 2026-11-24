#!/usr/bin/env node
/**
 * zstack Live Mission Control Dashboard Server (Board v2)
 * Zero external dependencies (Node >= 20 ESM).
 *
 * - Strictly bound to loopback (127.0.0.1 / localhost / ::1)
 * - Read-only on projects & receipts; writes only inside zstack (tasks/active/*, tasks/archive/*, tasks/BOARD.md, tasks/BACKLOG.md, .zstack-cache/inbox.jsonl)
 * - Live SSE push on fs.watch changes to tasks/ and .zstack-cache/
 * - Real-time read/write APIs: POST /api/items, PATCH /api/tasks/:id, POST /api/tasks/:id/thread, POST /api/releases/:id/complete
 * - Optional server-side HMAC-signed webhook dispatch to T3 Code (secrets never sent to browser)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createGitHubPoller } from "./github-poller.mjs";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_BUCKETS,
  ALLOWED_KINDS,
  ALLOWED_OWNERS,
  ALLOWED_PHASES,
  ALLOWED_PRIORITIES,
  ALLOWED_SEVERITIES,
  DEFAULT_LEASE_MINUTES,
  aggregateReleaseTasks,
  archiveTaskDirectory,
  buildUnifiedThread,
  computeLeaseStatus,
  defaultReleaseChecklist,
  detectMigration,
  extractActiveModel,
  getPrUrls,
  inferBucket,
  inferKind,
  inferOwner,
  inferSeverity,
  isNowChannelTask,
  isSafeTaskId,
  listArchivedIndex,
  nowIso,
  rebuildBoard,
  resolveDependencies,
  safeJsonParse,
  slugifyTaskId,
} from "./board-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, "..");

function loadProjects(root) {
  const projectsDir = path.join(root, "projects");
  const projects = {};
  if (!fs.existsSync(projectsDir)) return projects;

  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const yamlPath = path.join(projectsDir, entry.name, "project.yaml");
    if (!fs.existsSync(yamlPath)) continue;
    const text = fs.readFileSync(yamlPath, "utf8");
    const get = (re) => {
      const m = text.match(re);
      return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
    };
    const mergeBlock = text.match(/merge:\s*\n([\s\S]*?)(?:\n\s{2}\w+:|\n\w+:|$)/);
    const mergePolicy = mergeBlock?.[1]?.match(/policy:\s*["']?([^"'\n#]+)["']?/)?.[1]?.trim() || "human_required";
    projects[entry.name] = {
      slug: entry.name,
      display_name: get(/^display_name:\s*(.+)$/m) || entry.name,
      environment_id: get(/^\s*environment_id:\s*["']?([^"'\n#]+)["']?/m),
      project_id: get(/^\s*project_id:\s*["']?([^"'\n#]+)["']?/m),
      canonical_repo: get(/^\s*canonical:\s*["']?([^"'\n#]+)["']?/m),
      merge_policy: mergePolicy,
    };
  }
  return projects;
}

function loadTaskReceipts(taskDirPath) {
  const receiptsDir = path.join(taskDirPath, "receipts");
  if (!fs.existsSync(receiptsDir)) return [];
  const list = [];
  for (const name of fs.readdirSync(receiptsDir)) {
    if (!name.endsWith(".json")) continue;
    const full = path.join(receiptsDir, name);
    const stat = fs.statSync(full);
    const data = safeJsonParse(fs.readFileSync(full, "utf8"));
    if (!data) continue;
    const findings = Array.isArray(data.findings) ? data.findings : [];
    const checks = Array.isArray(data.checks) ? data.checks : [];
    const openBlockers = findings.filter((f) => f.status === "open" && f.severity === "blocker").length;
    const openMajors = findings.filter((f) => f.status === "open" && f.severity === "major").length;
    const openMinors = findings.filter((f) => f.status === "open" && f.severity === "minor").length;
    const resolvedCount = findings.filter((f) => f.status === "resolved").length;
    const checksPass = checks.filter((c) => c.result === "pass").length;
    const checksFail = checks.filter((c) => c.result === "fail").length;
    list.push({
      file: name,
      mtime: stat.mtime.toISOString(),
      step_id: data.step_id || name,
      role: data.role || "unknown",
      status: data.status || "unknown",
      pr_url: data.git_evidence?.pr_url || null,
      head_sha: data.git_evidence?.head_sha || null,
      merged_commit_sha: data.git_evidence?.merged_commit_sha || null,
      working_tree_clean: data.git_evidence?.working_tree_clean ?? null,
      open_blockers: openBlockers,
      open_majors: openMajors,
      open_minors: openMinors,
      resolved_count: resolvedCount,
      checks_pass: checksPass,
      checks_fail: checksFail,
      checks_total: checks.length,
      findings,
      checks,
      open_risks: Array.isArray(data.open_risks) ? data.open_risks : [],
      next_recommendation: data.next_recommendation || null,
    });
  }
  list.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return list;
}

function loadTaskEvents(taskDirPath, limit = 80) {
  const eventsPath = path.join(taskDirPath, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, "utf8").split("\n").filter((l) => l.trim());
  const parsed = [];
  for (const line of lines) {
    const obj = safeJsonParse(line);
    if (obj) parsed.push(obj);
  }
  return parsed.slice(-limit).reverse();
}

function decorateThread(thread, envId) {
  if (!thread || !thread.thread_id) return null;
  return {
    ...thread,
    t3_link: envId ? `t3-thread://v2/${envId}/${thread.thread_id}` : null,
  };
}

function loadWebhookConfig(root) {
  const cfgPath = path.join(root, ".zstack-cache", "webhook.json");
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = safeJsonParse(fs.readFileSync(cfgPath, "utf8"));
  if (!cfg || !cfg.webhook_url || !cfg.secret) return null;
  return cfg;
}

function loadInbox(root, limit = 50) {
  const inboxPath = path.join(root, ".zstack-cache", "inbox.jsonl");
  if (!fs.existsSync(inboxPath)) return [];
  const lines = fs.readFileSync(inboxPath, "utf8").split("\n").filter((l) => l.trim());
  const byId = new Map();
  for (const line of lines) {
    const item = safeJsonParse(line);
    if (!item || !item.id) continue;
    byId.set(item.id, { ...(byId.get(item.id) || {}), ...item });
  }
  return [...byId.values()].sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, limit);
}

function appendInbox(root, record) {
  const cacheDir = path.join(root, ".zstack-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const inboxPath = path.join(cacheDir, "inbox.jsonl");
  fs.appendFileSync(inboxPath, JSON.stringify(record) + "\n", "utf8");
}

function loadActiveTasks(root, projects, archivedById, inbox) {
  const activeRoot = path.join(root, "tasks", "active");
  if (!fs.existsSync(activeRoot)) return [];

  const rawEntries = [];
  for (const entry of fs.readdirSync(activeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(activeRoot, entry.name);
    const statePath = path.join(dirPath, "state.json");
    if (!fs.existsSync(statePath)) continue;
    const state = safeJsonParse(fs.readFileSync(statePath, "utf8"));
    if (!state) continue;
    rawEntries.push({ dirPath, state });
  }

  const activeById = new Map(rawEntries.map((r) => [r.state.task_id, r.state]));
  const tasks = [];

  for (const { dirPath, state } of rawEntries) {
    const proj = projects[state.project_slug] || {};
    const envId = proj.environment_id || null;
    const receipts = loadTaskReceipts(dirPath);
    const events = loadTaskEvents(dirPath);
    const latestReview = receipts.find((r) => r.role === "reviewer") || null;

    const prs = getPrUrls(state);
    const primaryPrUrl = state.pull_request?.url || (prs.length === 1 ? prs[0] : null);
    const latestReceipt = receipts[0];
    const receiptMatchesPr = latestReceipt && (!latestReceipt.pr_url || latestReceipt.pr_url === primaryPrUrl);
    const pullRequest = primaryPrUrl
      ? { ...state.pull_request, url: primaryPrUrl, head_sha: (receiptMatchesPr && latestReceipt.head_sha) || state.pull_request?.head_sha || null }
      : state.pull_request;
    const kind = inferKind(state);
    const owner = inferOwner(state);
    const bucket = state.phase === "backlog" ? inferBucket(state) : state.bucket || null;
    const severity = inferSeverity(state, kind);
    const hasMigration = detectMigration(state, receipts);
    const depInfo = resolveDependencies(state, activeById, archivedById);
    const leaseInfo = computeLeaseStatus(state, events, receipts);
    const activeModel = extractActiveModel(state, events);

    const threads = {
      implementer: decorateThread(state.threads?.implementer, envId),
      reviewers: (state.threads?.reviewers || []).map((t) => decorateThread(t, envId)).filter(Boolean),
      investigators: (state.threads?.investigators || []).map((t) => decorateThread(t, envId)).filter(Boolean),
      merger: decorateThread(state.threads?.merger, envId),
    };

    const threadTimeline = buildUnifiedThread(state, events, receipts, inbox);

    const checklist = Array.isArray(state.checklist)
      ? state.checklist.map((item, i) => ({
          id: String(item.id || `item-${i + 1}`),
          label: String(item.label || ""),
          done: Boolean(item.done),
        }))
      : [];

    tasks.push({
      ...state,
      pull_request: pullRequest,
      kind,
      severity,
      owner,
      bucket,
      source: state.source || null,
      release_id: state.release_id || null,
      has_migration: hasMigration,
      ...depInfo,
      ...leaseInfo,
      active_model: activeModel,
      checklist,
      checklist_done: checklist.filter((c) => c.done).length,
      checklist_total: checklist.length,
      prs: prs.map((url) => {
        const m = String(url).match(/\/pull\/(\d+)$/);
        return { url, number: m ? Number(m[1]) : null };
      }),
      threads,
      review_rounds: threads.reviewers.length,
      is_external_pr: !threads.implementer && prs.length > 0 && kind !== "release",
      latest_review: latestReview
        ? {
            file: latestReview.file,
            step_id: latestReview.step_id,
            status: latestReview.status,
            head_sha: latestReview.head_sha,
            open_blockers: latestReview.open_blockers,
            open_majors: latestReview.open_majors,
            open_minors: latestReview.open_minors,
            resolved_count: latestReview.resolved_count,
            next_recommendation: latestReview.next_recommendation,
          }
        : null,
      receipts,
      events,
      thread: threadTimeline,
    });
  }

  // Enrich release trains with auto-aggregated merged_pending_release tasks
  for (const t of tasks) {
    if (t.kind === "release") {
      const agg = aggregateReleaseTasks(t, tasks);
      Object.assign(t, agg);
    }
  }

  const priRank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  tasks.sort((a, b) => {
    const tDiff = String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    if (tDiff !== 0) return tDiff;
    return (priRank[a.priority] ?? 9) - (priRank[b.priority] ?? 9);
  });
  return tasks;
}

function loadArchivedSummary(archivedById, limit = 40) {
  const all = [];
  for (const s of archivedById.values()) {
    const kind = inferKind(s);
    all.push({
      task_id: s.task_id,
      project_slug: s.project_slug,
      kind,
      priority: s.priority || "-",
      severity: inferSeverity(s, kind),
      title: s.title,
      archived_at: s.archived_at || s.updated_at || null,
      archive_reason: s.archive_reason || null,
      pr_url: s.pull_request?.url || s.pull_requests?.[0] || null,
    });
  }
  all.sort((a, b) => String(b.archived_at || "").localeCompare(String(a.archived_at || "")));
  return { count: all.length, recent: all.slice(0, limit) };
}

function buildLiveBacklogGroups(activeTasks) {
  const backlogTasks = activeTasks.filter((t) => t.phase === "backlog");
  const priRank = { P0: 0, P1: 1, P2: 2, "-": 3 };
  const sortFn = (a, b) => {
    const pd = (priRank[a.priority] ?? 9) - (priRank[b.priority] ?? 9);
    if (pd !== 0) return pd;
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  };
  const defs = [
    { key: "must", heading: "明确要做 · MUST" },
    { key: "maybe", heading: "可能亲自做 · MAYBE" },
    { key: "team", heading: "团队想法 · TEAM" },
  ];
  return defs.map((d) => ({
    key: d.key,
    heading: d.heading,
    items: backlogTasks
      .filter((t) => (t.bucket || "must") === d.key)
      .sort(sortFn)
      .map((t) => ({
        task_id: t.task_id,
        id: t.task_id,
        bucket: d.key,
        section: d.key,
        project: t.project_slug,
        project_slug: t.project_slug,
        priority: t.priority || "P1",
        owner: t.owner || "me",
        title: t.title,
        notes: t.next_step || "-",
        is_blocked_by_deps: t.is_blocked_by_deps,
        blocking_deps: t.blocking_deps,
        has_migration: t.has_migration,
        updated_at: t.updated_at,
      })),
  }));
}

function buildCopyCommand(action) {
  if (action.source === "github-poller") {
    return `[GitHub 自动事件 ${action.id}] ${action.kind} ${action.pr_url}${action.head_sha ? ` @ ${action.head_sha}` : ""}${action.comment_id ? ` · ${action.comment_type} #${action.comment_id}` : ""}。按 SOP 核对远端状态及 inbox。此事件仅用于复审或整理待办，不代表用户批准写入、合并或发布。`;
  }
  if (action.kind === "decision") {
    const pr = action.pr_number ? `PR #${action.pr_number}` : action.pr_url || action.task_id;
    const map = {
      approve_merge: `批准合并 ${action.task_id}`,
      approve_pr: `请核对最新复审对应的 PR head，并提交 Approve ${pr}`,
      request_changes: `按最新复审意见在 ${pr} 提交 Request Changes`,
      continue_round: `授权 ${action.task_id} 继续推进当前待办，并保留后续审批关卡`,
      custom: `${action.task_id}: ${action.note || ""}`,
    };
    return `[看板动作 ${action.id}] ${map[action.decision] || action.decision}${action.note && action.decision !== "custom" ? `（备注：${action.note}）` : ""}`;
  }
  if (action.kind === "check_status") {
    return `[看板动作 ${action.id}] 核对任务 ${action.task_id}：用 t3_thread_read 核实当前绑定线程的真实状态，再用 zstack append-event 写入 heartbeat，记录核对结果。`;
  }
  if (action.kind === "thread_steer") {
    return `[看板动作 ${action.id}] 针对任务 ${action.task_id} 的指令：${action.note || ""}`;
  }
  if (action.kind === "review_pr") {
    return `[看板动作 ${action.id}] 复审 PR ${action.pr_url || "#" + action.pr_number}${action.note ? `（${action.note}）` : ""}`;
  }
  if (action.kind === "start_backlog") {
    const modeLabel = action.mode === "investigate" ? "先做只读调研" : "立项开工";
    return `[看板动作 ${action.id}] 从 Backlog ${modeLabel}${action.task_id ? `（task_id=${action.task_id}）` : ""}：${action.title}（${action.project_slug}）${action.note ? ` — ${action.note}` : ""}`;
  }
  if (action.kind === "triage_bug") {
    const modeLabel = action.mode === "investigate" ? "派只读排查 (Investigator)" : "派修 Bug (Implementer → Reviewer)";
    return `[看板动作 ${action.id}] Bug ${modeLabel}（task_id=${action.task_id || "-"} / ${action.project_slug || "-"} / ${action.severity || action.priority || "P1"}）：${action.title || ""}${action.note ? ` — ${action.note}` : ""}`;
  }
  return `[看板动作 ${action.id}] 新建任务${action.task_id ? `（task_id=${action.task_id}）` : ""}（${action.project_slug || "-"} / ${action.priority || "P1"} / ${action.mode || "implement"}）：${action.title || ""}${action.note ? ` — ${action.note}` : ""}`;
}

async function dispatchWebhook(root, action) {
  const cfg = loadWebhookConfig(root);
  if (!cfg) {
    return { delivered: false, mode: "local-inbox", status: null, error: null };
  }
  const payload = JSON.stringify({
    source: "zstack-dashboard",
    action_id: action.id,
    ts: action.ts,
    action,
    instruction: buildCopyCommand(action),
  });
  const sig = crypto.createHmac("sha256", cfg.secret).update(payload).digest("hex");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(cfg.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-zstack-signature": `sha256=${sig}`,
      },
      body: payload,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { delivered: false, mode: "t3-webhook", status: res.status, error: `HTTP ${res.status}: ${text.slice(0, 180)}` };
    }
    return { delivered: true, mode: "t3-webhook", status: res.status, error: null };
  } catch (err) {
    return { delivered: false, mode: "t3-webhook", status: null, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function emitInboxAction(root, fields) {
  const eventKey = fields.event_key;
  const previous = eventKey && loadInbox(root, Infinity).find(item => item.event_key === eventKey);
  if (previous) return { action: previous, copy_command: previous.copy_command };
  const actionId = `act-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
  const action = {
    id: actionId,
    ts: nowIso(),
    ...fields,
    delivery: "queued",
    delivery_error: null,
  };
  const copyCommand = buildCopyCommand(action);
  action.copy_command = copyCommand;
  appendInbox(root, action);

  const result = await dispatchWebhook(root, action);
  const updated = {
    ...action,
    delivery: result.delivered ? "t3-webhook" : result.mode === "t3-webhook" ? "webhook-failed" : "local-inbox",
    delivery_status: result.status,
    delivery_error: result.error,
  };
  appendInbox(root, updated);
  return { action: updated, copy_command: copyCommand };
}

function readProjectMergePolicy(root, slug) {
  const projectFile = path.join(root, "projects", slug, "project.yaml");
  if (!fs.existsSync(projectFile)) return "human_approval_required";
  const text = fs.readFileSync(projectFile, "utf8");
  const mergeBlock = text.match(/merge:\s*\n([\s\S]*?)(?:\n\s{2}\w+:|\n\w+:|$)/);
  const policyMatch = mergeBlock?.[1]?.match(/policy:\s*["']?([^"'\n#]+)["']?/);
  return policyMatch ? policyMatch[1].trim() : "human_approval_required";
}

function createTaskOnDisk(root, payload) {
  const projects = loadProjects(root);
  const projectSlug = String(payload.project_slug || payload.project || Object.keys(projects)[0] || "example").trim();
  if (!/^[a-z0-9][a-z0-9-_]{0,60}$/.test(projectSlug)) {
    throw new Error(`Invalid project_slug "${projectSlug}"`);
  }
  const title = String(payload.title || "").trim().slice(0, 240);
  if (!title) throw new Error("Title is required");

  const kind = ALLOWED_KINDS.has(payload.kind) ? payload.kind : "feature";
  const activeRoot = path.join(root, "tasks", "active");
  fs.mkdirSync(activeRoot, { recursive: true });
  const existingIds = new Set(fs.readdirSync(activeRoot));

  let taskId = payload.task_id ? String(payload.task_id).trim() : slugifyTaskId(projectSlug, kind, title, existingIds);
  if (!isSafeTaskId(taskId)) {
    throw new Error(`Invalid task_id "${taskId}"`);
  }
  if (fs.existsSync(path.join(activeRoot, taskId))) {
    throw new Error(`Task "${taskId}" already exists`);
  }

  const dispatchMode = payload.dispatch_mode || "none";
  let phase = payload.phase;
  if (!phase) {
    if (kind === "bug") {
      phase = dispatchMode !== "none" ? "in_progress" : "intake";
    } else if (kind === "release") {
      phase = "intake";
    } else {
      phase = dispatchMode !== "none" ? "intake" : "backlog";
    }
  }
  if (!ALLOWED_PHASES.has(phase)) {
    throw new Error(`Invalid phase "${phase}"`);
  }

  const severity =
    kind === "bug"
      ? ALLOWED_SEVERITIES.has(payload.severity)
        ? payload.severity
        : ALLOWED_SEVERITIES.has(payload.priority)
          ? payload.priority
          : "P1"
      : ALLOWED_SEVERITIES.has(payload.severity)
        ? payload.severity
        : null;

  const priority = ALLOWED_PRIORITIES.has(payload.priority)
    ? payload.priority
    : severity
      ? severity === "P3"
        ? "P2"
        : severity
      : "P1";

  let bucket = null;
  if (ALLOWED_BUCKETS.has(payload.bucket)) {
    bucket = payload.bucket;
  } else if (payload.section) {
    if (payload.section === "my_queue_must") bucket = "must";
    else if (payload.section === "my_queue_maybe") bucket = "maybe";
    else if (payload.section === "team_ideas") bucket = "team";
  } else if (phase === "backlog") {
    bucket = payload.owner === "team" ? "team" : "must";
  }

  const owner = ALLOWED_OWNERS.has(payload.owner) ? payload.owner : bucket === "team" ? "team" : "me";
  const source = payload.source ? String(payload.source).trim().slice(0, 80) : kind === "bug" ? "developer" : "manual";
  const dependsOn = Array.isArray(payload.depends_on)
    ? [...new Set(payload.depends_on.map((x) => String(x || "").trim()).filter(isSafeTaskId))]
    : [];
  const nextStep = String(payload.next_step || payload.note || payload.notes || "").trim().slice(0, 1500) || null;
  const mergePolicy = readProjectMergePolicy(root, projectSlug);
  const ts = nowIso();

  const checklist =
    kind === "release"
      ? Array.isArray(payload.checklist) && payload.checklist.length > 0
        ? payload.checklist.map((item, i) => ({
            id: String(item.id || `step-${i + 1}`),
            label: String(item.label || "").trim(),
            done: Boolean(item.done),
          }))
        : defaultReleaseChecklist(projectSlug)
      : undefined;

  const state = {
    schema_version: 1,
    task_id: taskId,
    project_slug: projectSlug,
    kind,
    title,
    priority,
    ...(severity ? { severity } : {}),
    owner,
    ...(bucket ? { bucket } : {}),
    source,
    depends_on: dependsOn,
    ...(typeof payload.has_migration === "boolean" ? { has_migration: payload.has_migration } : {}),
    release_id: payload.release_id || null,
    ...(checklist ? { checklist } : {}),
    lease_minutes:
      typeof payload.lease_minutes === "number" && payload.lease_minutes > 0
        ? payload.lease_minutes
        : DEFAULT_LEASE_MINUTES,
    phase,
    next_step: nextStep,
    created_at: ts,
    updated_at: ts,
    threads: {
      implementer: null,
      reviewers: [],
      investigators: [],
      merger: null,
    },
    pull_request: null,
    pull_requests: [],
    gates: {
      independent_review_pass: {
        satisfied: false,
        verified_head_sha: null,
        reviewer_thread_id: null,
        receipt_path: null,
      },
      merge_authorization: {
        policy: mergePolicy,
        approved: false,
        approved_by: null,
        approved_head_sha: null,
        approved_at: null,
      },
      deploy_authorization: {
        policy: "forbidden_by_default",
        requested: false,
        approved: false,
      },
    },
    idempotency_keys: {},
    open_risks: [],
  };

  const dir = path.join(activeRoot, taskId);
  fs.mkdirSync(path.join(dir, "receipts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");

  const eventsPath = path.join(dir, "events.jsonl");
  fs.appendFileSync(
    eventsPath,
    JSON.stringify({
      ts,
      type: "task_initialized",
      actor: "you",
      project_slug: projectSlug,
      kind,
      title,
      priority,
      ...(severity ? { severity } : {}),
      owner,
      ...(bucket ? { bucket } : {}),
      source,
      phase,
    }) + "\n",
    "utf8"
  );

  if (payload.note && String(payload.note).trim()) {
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        ts,
        type: "human_message",
        actor: "you",
        steer: dispatchMode !== "none",
        body: String(payload.note).trim().slice(0, 2000),
      }) + "\n",
      "utf8"
    );
  }

  return state;
}

function patchTaskOnDisk(root, taskId, body) {
  const dir = path.join(root, "tasks", "active", taskId);
  const statePath = path.join(dir, "state.json");
  if (!fs.existsSync(statePath)) {
    const err = new Error(`Task "${taskId}" not found`);
    err.statusCode = 404;
    throw err;
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const eventsPath = path.join(dir, "events.jsonl");
  const ts = nowIso();
  const changes = [];
  let prevPhase = state.phase;
  let phaseChanged = false;

  if (body.title !== undefined) {
    const t = String(body.title).trim().slice(0, 240);
    if (!t) throw new Error("Title cannot be empty");
    if (t !== state.title) {
      state.title = t;
      changes.push("title");
    }
  }
  if (body.priority !== undefined) {
    if (!ALLOWED_PRIORITIES.has(body.priority)) throw new Error(`Invalid priority "${body.priority}"`);
    if (body.priority !== state.priority) {
      state.priority = body.priority;
      changes.push(`priority=${body.priority}`);
    }
  }
  if (body.severity !== undefined) {
    if (body.severity !== null && !ALLOWED_SEVERITIES.has(body.severity)) {
      throw new Error(`Invalid severity "${body.severity}"`);
    }
    if (body.severity !== state.severity) {
      state.severity = body.severity;
      if (inferKind(state) === "bug" && body.severity && body.priority === undefined) {
        state.priority = body.severity === "P3" ? "P2" : body.severity;
      }
      changes.push(`severity=${body.severity || "none"}`);
    }
  }
  if (body.owner !== undefined) {
    if (!ALLOWED_OWNERS.has(body.owner)) throw new Error(`Invalid owner "${body.owner}"`);
    if (body.owner !== state.owner) {
      state.owner = body.owner;
      changes.push(`owner=${body.owner}`);
    }
  }
  if (body.bucket !== undefined) {
    if (body.bucket !== null && !ALLOWED_BUCKETS.has(body.bucket)) {
      throw new Error(`Invalid bucket "${body.bucket}"`);
    }
    if (body.bucket !== state.bucket) {
      state.bucket = body.bucket;
      if (body.bucket === "team" && body.owner === undefined) state.owner = "team";
      changes.push(`bucket=${body.bucket || "none"}`);
    }
  }
  if (body.source !== undefined) {
    state.source = body.source ? String(body.source).trim().slice(0, 80) : null;
    changes.push(`source=${state.source || "none"}`);
  }
  if (body.next_step !== undefined) {
    state.next_step = body.next_step ? String(body.next_step).trim().slice(0, 1500) : null;
    changes.push("next_step");
  }
  if (body.has_migration !== undefined) {
    state.has_migration = Boolean(body.has_migration);
    changes.push(`has_migration=${state.has_migration}`);
  }
  if (body.release_id !== undefined) {
    state.release_id = body.release_id ? String(body.release_id).trim() : null;
    changes.push(`release_id=${state.release_id || "none"}`);
  }
  if (body.lease_minutes !== undefined) {
    const lm = Number(body.lease_minutes);
    if (!Number.isFinite(lm) || lm <= 0) throw new Error("Invalid lease_minutes");
    state.lease_minutes = lm;
    changes.push(`lease_minutes=${lm}`);
  }
  if (body.depends_on !== undefined) {
    if (!Array.isArray(body.depends_on)) throw new Error("depends_on must be an array");
    state.depends_on = [...new Set(body.depends_on.map((x) => String(x || "").trim()).filter((x) => isSafeTaskId(x) && x !== taskId))];
    changes.push(`depends_on=[${state.depends_on.join(",")}]`);
  }
  if (body.phase !== undefined) {
    if (!ALLOWED_PHASES.has(body.phase)) throw new Error(`Invalid phase "${body.phase}"`);
    if (body.phase !== state.phase) {
      state.phase = body.phase;
      phaseChanged = true;
    }
  }

  let checklistSummary = null;
  if (body.checklist !== undefined) {
    if (!Array.isArray(body.checklist)) throw new Error("checklist must be an array");
    const prev = Array.isArray(state.checklist) ? state.checklist : [];
    const prevMap = new Map(prev.map((c) => [c.id, Boolean(c.done)]));
    state.checklist = body.checklist.map((item, i) => ({
      id: String(item.id || `item-${i + 1}`),
      label: String(item.label || "").trim().slice(0, 240),
      done: Boolean(item.done),
    }));
    const toggled = state.checklist.filter((c) => prevMap.get(c.id) !== c.done);
    if (toggled.length > 0) {
      checklistSummary = toggled.map((c) => `${c.done ? "✓" : "○"} ${c.label}`).join("; ");
    } else {
      checklistSummary = `更新发版检查清单 (${state.checklist.filter((c) => c.done).length}/${state.checklist.length})`;
    }
  }

  state.updated_at = ts;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  if (phaseChanged) {
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        ts,
        type: "phase_updated",
        actor: "you",
        from: prevPhase,
        to: state.phase,
        next_step: state.next_step,
      }) + "\n",
      "utf8"
    );
  }
  if (checklistSummary) {
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        ts,
        type: "checklist_updated",
        actor: "you",
        summary: "发版检查项更新",
        detail: checklistSummary,
      }) + "\n",
      "utf8"
    );
  }
  if (changes.length > 0) {
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        ts,
        type: "task_updated",
        actor: "you",
        summary: "更新属性",
        detail: changes.join(" · "),
      }) + "\n",
      "utf8"
    );
  }

  return state;
}

function buildSnapshot(root) {
  const projects = loadProjects(root);
  const archivedById = listArchivedIndex(root);
  const inbox = loadInbox(root);
  const activeTasks = loadActiveTasks(root, projects, archivedById, inbox);
  const archived = loadArchivedSummary(archivedById);
  const backlog = buildLiveBacklogGroups(activeTasks);
  const webhookCfg = loadWebhookConfig(root);

  const nowTasks = activeTasks.filter(isNowChannelTask);
  const bugTasks = activeTasks.filter((t) => t.kind === "bug");
  const backlogTasks = activeTasks.filter((t) => t.phase === "backlog");
  const releaseTasks = activeTasks.filter((t) => t.kind === "release");
  const p0Bugs = bugTasks.filter(
    (t) => (t.severity === "P0" || t.priority === "P0") && t.phase !== "merged_pending_release" && t.phase !== "completed"
  );
  const staleTasks = activeTasks.filter((t) => t.is_stale);

  const counts = {
    // 5-Channel counts
    now: nowTasks.length,
    bugs: bugTasks.length,
    backlog: backlogTasks.length,
    releases: releaseTasks.length,
    archive: archived.count,
    // High-signal alerts
    needs_human: activeTasks.filter((t) => t.phase === "needs_human").length,
    p0_bugs: p0Bugs.length,
    stale_count: staleTasks.length,
    // Legacy / detailed phase counts
    in_progress: activeTasks.filter((t) => t.phase === "in_progress").length,
    in_review: activeTasks.filter((t) => t.phase === "in_review").length,
    blocked: activeTasks.filter((t) => t.phase === "blocked").length,
    intake: activeTasks.filter((t) => t.phase === "intake").length,
    merged_pending_release: activeTasks.filter((t) => t.phase === "merged_pending_release").length,
    active_total: activeTasks.filter((t) => t.phase !== "backlog").length,
    archived_total: archived.count,
    backlog_total: backlogTasks.length,
  };

  return {
    generated_at: nowIso(),
    webhook: {
      configured: Boolean(webhookCfg),
      mode: webhookCfg ? "t3-webhook" : "local-inbox",
      scheduled_task_id: webhookCfg?.scheduled_task_id || null,
    },
    counts,
    projects: Object.values(projects),
    active_tasks: activeTasks,
    backlog,
    archived_count: archived.count,
    archived_recent: archived.recent,
    inbox,
  };
}

function readJsonBody(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function startDashboardServer({ root = DEFAULT_ROOT, host = "127.0.0.1", port = 4390 } = {}) {
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Refusing non-loopback host "${host}". Dashboard must bind strictly to loopback.`);
  }

  const uiPath = path.join(root, "scripts", "dashboard-ui.html");
  const clients = new Set();
  const github = createGitHubPoller({
    root,
    loadProjects: () => loadProjects(root),
    emit: fields => emitInboxAction(root, fields),
  });

  const broadcastSnapshot = () => {
    if (clients.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify(buildSnapshot(root));
    } catch {
      return;
    }
    for (const res of clients) {
      try {
        res.write(`event: snapshot\ndata: ${payload}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
  };

  let debounceTimer = null;
  const scheduleBroadcast = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcastSnapshot();
    }, 150);
  };

  const watchers = [];
  for (const rel of ["tasks", ".zstack-cache"]) {
    const watchTarget = path.join(root, rel);
    fs.mkdirSync(watchTarget, { recursive: true });
    try {
      const w = fs.watch(watchTarget, { recursive: true }, () => scheduleBroadcast());
      watchers.push(w);
    } catch {
      // Fallback: client still gets manual refresh & post-action push
    }
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
  }, 25000);
  heartbeat.unref?.();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${host}:${port}`);
    const pathname = reqUrl.pathname;

    try {
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const html = fs.readFileSync(uiPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { ok: true, ts: nowIso() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/github/status") {
        sendJson(res, 200, github.status());
        return;
      }

      if ((req.method === "POST" && pathname === "/api/github/sync") ||
          (req.method === "PATCH" && pathname === "/api/github/config")) {
        const expectedOrigin = `http://${req.headers.host}`;
        if ((req.headers.origin && req.headers.origin !== expectedOrigin) ||
            req.headers["sec-fetch-site"] === "cross-site" ||
            req.headers["content-type"]?.split(";")[0] !== "application/json") {
          sendJson(res, 403, { ok: false, error: "GitHub mutations require a same-origin JSON request" });
          return;
        }
        const body = await readJsonBody(req);
        const data = req.method === "POST" ? await github.sync() : github.update(body);
        sendJson(res, 200, data);
        return;
      }

      if (req.method === "GET" && pathname === "/api/snapshot") {
        sendJson(res, 200, buildSnapshot(root));
        return;
      }

      if (req.method === "GET" && pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        clients.add(res);
        res.write(`event: snapshot\ndata: ${JSON.stringify(buildSnapshot(root))}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }

      // Unified creation endpoint: feature (backlog or active), bug (quick triage), release train
      if (req.method === "POST" && pathname === "/api/items") {
        const body = await readJsonBody(req);
        const created = createTaskOnDisk(root, body);
        rebuildBoard(root);

        let dispatched = null;
        const dispatchMode = body.dispatch_mode || "none";
        if (dispatchMode !== "none") {
          const actionKind = created.kind === "bug" ? "triage_bug" : "new_task";
          dispatched = await emitInboxAction(root, {
            kind: actionKind,
            task_id: created.task_id,
            project_slug: created.project_slug,
            priority: created.priority,
            severity: created.severity || null,
            mode: dispatchMode,
            title: created.title,
            note: body.note ? String(body.note).trim().slice(0, 1000) : null,
          });
        }

        broadcastSnapshot();
        sendJson(res, 200, {
          ok: true,
          task: created,
          action: dispatched?.action || null,
          copy_command: dispatched?.copy_command || null,
        });
        return;
      }

      // Backward-compatible POST /api/backlog -> creates a real phase="backlog" task
      if (req.method === "POST" && pathname === "/api/backlog") {
        const body = await readJsonBody(req);
        const created = createTaskOnDisk(root, {
          kind: "feature",
          phase: "backlog",
          project_slug: body.project || body.project_slug,
          priority: body.priority || "P1",
          section: body.section || "my_queue_must",
          bucket: body.bucket,
          owner: body.owner,
          title: body.title,
          next_step: body.notes || body.note || "-",
          dispatch_mode: "none",
        });
        rebuildBoard(root);
        broadcastSnapshot();
        sendJson(res, 200, { ok: true, task: created });
        return;
      }

      // Real-time task metadata, phase, dependency, and checklist updates
      const taskPatchMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && taskPatchMatch) {
        const taskId = decodeURIComponent(taskPatchMatch[1]);
        if (!isSafeTaskId(taskId)) {
          sendJson(res, 400, { ok: false, error: "Invalid task_id" });
          return;
        }
        const body = await readJsonBody(req);
        const updated = patchTaskOnDisk(root, taskId, body);
        rebuildBoard(root);

        let dispatched = null;
        if (body.dispatch && typeof body.dispatch === "object") {
          const d = body.dispatch;
          dispatched = await emitInboxAction(root, {
            kind: d.kind || (updated.kind === "bug" ? "triage_bug" : "start_backlog"),
            task_id: updated.task_id,
            project_slug: updated.project_slug,
            priority: updated.priority,
            severity: updated.severity || null,
            mode: d.mode || "implement",
            title: updated.title,
            note: d.note ? String(d.note).trim().slice(0, 1000) : null,
          });
          const eventsPath = path.join(root, "tasks", "active", taskId, "events.jsonl");
          fs.appendFileSync(
            eventsPath,
            JSON.stringify({
              ts: nowIso(),
              type: "human_message",
              actor: "you",
              steer: true,
              action_id: dispatched.action.id,
              body: dispatched.copy_command,
            }) + "\n",
            "utf8"
          );
        }

        broadcastSnapshot();
        sendJson(res, 200, {
          ok: true,
          task: updated,
          action: dispatched?.action || null,
          copy_command: dispatched?.copy_command || null,
        });
        return;
      }

      // Unified Thread comment / steer endpoint
      const threadMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/thread$/);
      if (req.method === "POST" && threadMatch) {
        const taskId = decodeURIComponent(threadMatch[1]);
        if (!isSafeTaskId(taskId)) {
          sendJson(res, 400, { ok: false, error: "Invalid task_id" });
          return;
        }
        const dir = path.join(root, "tasks", "active", taskId);
        const statePath = path.join(dir, "state.json");
        if (!fs.existsSync(statePath)) {
          sendJson(res, 404, { ok: false, error: `Task "${taskId}" not found` });
          return;
        }
        const body = await readJsonBody(req);
        const text = String(body.body || body.message || "").trim().slice(0, 2000);
        if (!text) {
          sendJson(res, 400, { ok: false, error: "Message body is required" });
          return;
        }
        const steer = Boolean(body.steer);
        const actor = String(body.actor || "you").trim().slice(0, 40) || "you";
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

        let dispatched = null;
        if (steer) {
          dispatched = await emitInboxAction(root, {
            kind: "thread_steer",
            task_id: taskId,
            project_slug: state.project_slug,
            priority: state.priority || "P1",
            title: state.title,
            note: text,
          });
        }

        const ts = nowIso();
        const entry = {
          ts,
          type: "human_message",
          actor,
          steer,
          ...(dispatched?.action?.id ? { action_id: dispatched.action.id } : {}),
          body: text,
        };
        fs.appendFileSync(path.join(dir, "events.jsonl"), JSON.stringify(entry) + "\n", "utf8");
        state.updated_at = ts;
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

        broadcastSnapshot();
        sendJson(res, 200, {
          ok: true,
          entry,
          action: dispatched?.action || null,
          copy_command: dispatched?.copy_command || null,
        });
        return;
      }

      // Release train completion & batch archive
      const releaseCompleteMatch = pathname.match(/^\/api\/releases\/([^/]+)\/complete$/);
      if (req.method === "POST" && releaseCompleteMatch) {
        const releaseId = decodeURIComponent(releaseCompleteMatch[1]);
        if (!isSafeTaskId(releaseId)) {
          sendJson(res, 400, { ok: false, error: "Invalid release_id" });
          return;
        }
        const body = await readJsonBody(req);
        if (body.confirm !== true) {
          sendJson(res, 400, { ok: false, error: "Explicit confirmation (confirm: true) is required to complete a release." });
          return;
        }

        const releaseDir = path.join(root, "tasks", "active", releaseId);
        const releaseStatePath = path.join(releaseDir, "state.json");
        if (!fs.existsSync(releaseStatePath)) {
          sendJson(res, 404, { ok: false, error: `Release "${releaseId}" not found` });
          return;
        }
        const releaseState = JSON.parse(fs.readFileSync(releaseStatePath, "utf8"));
        if (inferKind(releaseState) !== "release") {
          sendJson(res, 400, { ok: false, error: `Task "${releaseId}" is not a release train` });
          return;
        }

        const releaseTag = body.release_tag ? String(body.release_tag).trim().slice(0, 60) : null;
        const note = body.note ? String(body.note).trim().slice(0, 500) : null;
        const snap = buildSnapshot(root);
        const releaseObj = snap.active_tasks.find((t) => t.task_id === releaseId);
        const candidateIds = (releaseObj?.included_tasks || []).map((t) => t.task_id);
        const targetIds = Array.isArray(body.task_ids)
          ? candidateIds.filter((id) => body.task_ids.includes(id))
          : candidateIds;

        const ts = nowIso();
        releaseState.released_at = ts;
        if (releaseTag) releaseState.release_tag = releaseTag;
        releaseState.released_task_ids = targetIds;
        releaseState.updated_at = ts;
        fs.writeFileSync(releaseStatePath, JSON.stringify(releaseState, null, 2) + "\n", "utf8");
        fs.appendFileSync(
          path.join(releaseDir, "events.jsonl"),
          JSON.stringify({
            ts,
            type: "release_completed",
            actor: "you",
            summary: `发版完成${releaseTag ? ` (${releaseTag})` : ""}`,
            detail: `批量归档 ${targetIds.length} 项待发版任务${note ? ` · ${note}` : ""}`,
            task_ids: targetIds,
          }) + "\n",
          "utf8"
        );

        const archiveReason = `released:${releaseId}${releaseTag ? `:${releaseTag}` : ""}`;
        const archivedTasks = [];
        for (const tid of targetIds) {
          if (fs.existsSync(path.join(root, "tasks", "active", tid, "state.json"))) {
            archivedTasks.push(archiveTaskDirectory(root, tid, archiveReason));
          }
        }
        const releaseArchived = archiveTaskDirectory(
          root,
          releaseId,
          `release_completed${releaseTag ? `:${releaseTag}` : ""}`
        );

        rebuildBoard(root);
        broadcastSnapshot();
        sendJson(res, 200, {
          ok: true,
          release_id: releaseId,
          release_tag: releaseTag,
          archived_tasks: archivedTasks,
          release_archived_to: releaseArchived.archived_to,
        });
        return;
      }

      const archiveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/archive$/);
      if (req.method === "POST" && archiveMatch) {
        const taskId = decodeURIComponent(archiveMatch[1]);
        if (!isSafeTaskId(taskId)) {
          sendJson(res, 400, { ok: false, error: "Invalid task_id" });
          return;
        }
        const body = await readJsonBody(req);
        const reason = String(body.reason || "archived_via_dashboard").trim().slice(0, 120);
        const result = archiveTaskDirectory(root, taskId, reason);
        rebuildBoard(root);
        broadcastSnapshot();
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && pathname === "/api/actions") {
        const body = await readJsonBody(req);
        const allowedKinds = new Set(["new_task", "start_backlog", "decision", "review_pr", "triage_bug", "thread_steer", "check_status"]);
        if (!allowedKinds.has(body.kind)) {
          sendJson(res, 400, { ok: false, error: `Invalid action kind "${body.kind}"` });
          return;
        }
        if ((body.task_id || body.kind === "check_status") && !isSafeTaskId(body.task_id)) {
          sendJson(res, 400, { ok: false, error: "Invalid task_id" });
          return;
        }
        const dispatched = await emitInboxAction(root, {
          kind: body.kind,
          task_id: body.task_id || null,
          project_slug: body.project_slug || Object.keys(loadProjects(root))[0] || "example",
          priority: body.priority || "P1",
          severity: body.severity || null,
          mode: body.mode || null,
          title: body.title ? String(body.title).trim().slice(0, 200) : null,
          pr_url: body.pr_url ? String(body.pr_url).trim().slice(0, 300) : null,
          pr_number: body.pr_number ? Number(body.pr_number) : null,
          decision: body.decision || null,
          note: body.note ? String(body.note).trim().slice(0, 1000) : null,
        });
        broadcastSnapshot();
        sendJson(res, 200, { ok: true, action: dispatched.action, copy_command: dispatched.copy_command });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const status = err?.statusCode || 500;
      sendJson(res, status, { ok: false, error: err?.message || String(err) });
    }
  });

  server.listen(port, host, () => {
    github.start();
    console.log(
      JSON.stringify({
        ok: true,
        url: `http://${host}:${port}`,
        root,
        webhook: loadWebhookConfig(root) ? "t3-webhook" : "local-inbox",
      })
    );
  });

  const shutdown = () => {
    github.stop();
    clearInterval(heartbeat);
    for (const client of clients) client.end();
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  let port = Number(process.env.ZSTACK_BOARD_PORT || 4390);
  let host = "127.0.0.1";
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--host") host = args[++i];
  }
  startDashboardServer({ root: DEFAULT_ROOT, host, port });
}
