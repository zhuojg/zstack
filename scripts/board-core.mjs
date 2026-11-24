/**
 * Shared zero-dependency Board v2 data model, inference, dependency graph,
 * lease detection, thread builder, release aggregation, and Markdown generators.
 *
 * Consumed by both scripts/zstack (CLI) and scripts/dashboard-server.mjs (HTTP/SSE).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ALLOWED_KINDS = new Set(["feature", "bug", "release", "review"]);
export const ALLOWED_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
export const ALLOWED_PRIORITIES = new Set(["P0", "P1", "P2", "-"]);
export const ALLOWED_OWNERS = new Set(["me", "team"]);
export const ALLOWED_BUCKETS = new Set(["must", "maybe", "team"]);
export const ALLOWED_PHASES = new Set([
  "backlog",
  "intake",
  "in_progress",
  "in_review",
  "blocked",
  "needs_human",
  "merged_pending_release",
  "completed",
  "archived",
  "implementing",
  "reviewing",
  "fixing",
  "ready_to_merge",
  "merging",
  "investigating",
  "blocked_provider",
  "blocked_dispatch",
  "closed",
]);

export const SATISFIED_DEP_PHASES = new Set([
  "merged_pending_release",
  "completed",
  "archived",
  "closed",
]);

export const DEFAULT_LEASE_MINUTES = 45;

export function nowIso() {
  return new Date().toISOString();
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function formatShanghaiTime(input, { withOffset = false } = {}) {
  const date = input ? new Date(input) : new Date();
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const base = `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}`;
  return withOffset ? `${base} +08:00` : base;
}

export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function isSafeTaskId(taskId) {
  return typeof taskId === "string" && /^[a-z0-9][a-z0-9-_]{1,100}$/.test(taskId);
}

export function slugifyTaskId(projectSlug, kind, title, existingIds = new Set()) {
  const prefixBase = String(projectSlug || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "task";
  const kindPrefix = kind === "bug" ? "bug-" : kind === "release" ? "release-" : "";
  const asciiPart = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");

  const dateTag = todayStr().replace(/-/g, "").slice(2); // YYMMDD
  const shortHash = crypto
    .createHash("sha1")
    .update(`${projectSlug}:${kind}:${title}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 4);

  const core = asciiPart
    ? `${prefixBase}-${kindPrefix}${asciiPart}`
    : `${prefixBase}-${kindPrefix}${dateTag}-${shortHash}`;

  let candidate = core.slice(0, 72).replace(/-+$/, "");
  if (candidate.length < 3) candidate = `${prefixBase}-${shortHash}`;
  if (!existingIds.has(candidate)) return candidate;

  for (let i = 2; i < 100; i++) {
    const next = `${candidate.slice(0, 66)}-${i}`;
    if (!existingIds.has(next)) return next;
  }
  return `${candidate.slice(0, 64)}-${shortHash}`;
}

export function getPrUrls(state) {
  if (Array.isArray(state.pull_requests) && state.pull_requests.length > 0) {
    return state.pull_requests.filter(Boolean);
  }
  if (state.pull_request?.url) {
    return [state.pull_request.url];
  }
  return [];
}

export function inferKind(state) {
  if (state && ALLOWED_KINDS.has(state.kind)) return state.kind;
  const prs = getPrUrls(state || {});
  if (!state?.threads?.implementer && prs.length > 0) return "review";
  return "feature";
}

export function inferOwner(state) {
  if (state && ALLOWED_OWNERS.has(state.owner)) return state.owner;
  if (state?.bucket === "team") return "team";
  return "me";
}

export function inferBucket(state) {
  if (state && ALLOWED_BUCKETS.has(state.bucket)) return state.bucket;
  if (state?.owner === "team") return "team";
  return "must";
}

export function inferSeverity(state, kind) {
  if (state && ALLOWED_SEVERITIES.has(state.severity)) return state.severity;
  if (kind === "bug") {
    if (ALLOWED_SEVERITIES.has(state?.priority)) return state.priority;
    return "P1";
  }
  return null;
}

const NEGATIVE_MIGRATION_PATTERNS = [
  /(?:严格\s*)?(?:零|无|不含|不涉及|没有)\s*(?:DB\s*|数据库\s*)?(?:迁移|migrations?)/gi,
  /\b(?:zero|no|without|non)[-\s]+(?:db\s+|database\s+)?migrations?\b/gi,
];

const POSITIVE_MIGRATION_REGEX =
  /packages\/db\/migrations|含\s*(?:DB\s*|数据库\s*)?迁移|数据库迁移|新增迁移|\bmigration\s+\d{3,4}\b|\b0146\b|\bdb\s+migration\b|\bschema\s+migration\b/i;

export function detectMigration(state, receipts = []) {
  if (state?.has_migration === true) return true;
  if (state?.has_migration === false) return false;

  const chunks = [state?.title || "", state?.next_step || ""];
  for (const r of receipts || []) {
    if (!r) continue;
    if (r.next_recommendation) chunks.push(r.next_recommendation);
    for (const risk of r.open_risks || []) {
      chunks.push(typeof risk === "string" ? risk : JSON.stringify(risk));
    }
    for (const f of r.findings || []) {
      chunks.push(`${f.location || ""} ${f.summary || ""}`);
    }
  }

  let text = chunks.join("\n");
  for (const re of NEGATIVE_MIGRATION_PATTERNS) {
    text = text.replace(re, " ");
  }
  return POSITIVE_MIGRATION_REGEX.test(text);
}

export function shortModelTag(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return null;
  const s = modelStr.trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low.includes("neon")) return "neon";
  if (low.includes("astra")) return "astra";
  if (low.includes("sol")) return "sol";
  if (low.includes("opus")) return "opus";
  if (low.includes("sonnet")) return "sonnet";
  if (low.includes("haiku")) return "haiku";
  if (low.includes("flash")) return "flash";
  const parts = s.split(/[/:_\s-]+/).filter(Boolean);
  return (parts[parts.length - 1] || s).slice(0, 12).toLowerCase();
}

export function extractActiveModel(state, eventsNewestFirst = []) {
  const th = state?.threads || {};
  const lastOf = (arr) => (Array.isArray(arr) && arr.length > 0 ? arr[arr.length - 1] : null);
  const phase = state?.phase;

  const candidates = [];
  if (phase === "merged_pending_release" || phase === "completed") {
    candidates.push(th.merger, lastOf(th.reviewers), th.implementer, lastOf(th.investigators));
  } else if (phase === "in_review") {
    candidates.push(lastOf(th.reviewers), th.implementer, lastOf(th.investigators), th.merger);
  } else {
    candidates.push(th.implementer, lastOf(th.investigators), lastOf(th.reviewers), th.merger);
  }

  for (const c of candidates) {
    if (c?.model) return shortModelTag(c.model);
  }

  for (const e of eventsNewestFirst || []) {
    if (e?.model) return shortModelTag(e.model);
  }

  if (phase === "in_progress" || phase === "in_review") {
    const next = String(state?.next_step || "");
    const m = next.match(/\b(gemini-4-neon|gpt-6\.2-astra|gpt-6\.2-sol|claude-opus-[0-9-]+|claude-sonnet-[0-9-]+)\b/i);
    if (m) return shortModelTag(m[1]);
  }
  return null;
}

export function defaultReleaseChecklist() {
  return [
    { id: "checks", label: "主干全量类型检查与核心测试通过", done: false },
    { id: "tags", label: "按变更组件顺序打 tag 并等待镜像构建完成", done: false },
    { id: "diff", label: "执行部署 diff 并记录当前回滚检查点", done: false },
    { id: "staging", label: "预发 / UAT 冒烟验证通过", done: false },
    { id: "prod-approval", label: "Prod 发布人工拍板确认", done: false },
  ];
}

export function isNowChannelTask(t) {
  if (!t) return false;
  if (["backlog", "merged_pending_release", "completed", "archived"].includes(t.phase)) {
    return false;
  }
  if (t.phase === "needs_human") return true;
  const kind = inferKind(t);
  if (kind === "release") return false;
  if (kind === "bug") {
    const sev = inferSeverity(t, kind);
    if (sev === "P0" || t.priority === "P0") return true;
    return ["in_progress", "in_review", "blocked"].includes(t.phase);
  }
  return true;
}

export function listArchivedIndex(root) {
  const archiveRoot = path.join(root, "tasks", "archive");
  const map = new Map();
  if (!fs.existsSync(archiveRoot)) return map;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory()) continue;
      const statePath = path.join(full, "state.json");
      if (fs.existsSync(statePath)) {
        const s = safeJsonParse(fs.readFileSync(statePath, "utf8"));
        if (s?.task_id) map.set(s.task_id, s);
      } else {
        walk(full);
      }
    }
  };
  walk(archiveRoot);
  return map;
}

export function listActiveTaskStates(root) {
  const activeRoot = path.join(root, "tasks", "active");
  if (!fs.existsSync(activeRoot)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(activeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(activeRoot, entry.name, "state.json");
    if (!fs.existsSync(statePath)) continue;
    const parsed = safeJsonParse(fs.readFileSync(statePath, "utf8"));
    if (parsed) rows.push(parsed);
  }
  rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  return rows;
}

export function resolveDependencies(task, activeById, archivedById) {
  const deps = Array.isArray(task.depends_on)
    ? [...new Set(task.depends_on.map((d) => String(d || "").trim()).filter(Boolean))]
    : [];
  const resolved = [];
  const blocking = [];
  for (const depId of deps) {
    const activeTarget = activeById.get(depId);
    const archivedTarget = archivedById.get(depId);
    if (archivedTarget) {
      resolved.push({
        task_id: depId,
        title: archivedTarget.title || depId,
        phase: "archived",
        satisfied: true,
      });
    } else if (activeTarget) {
      const sat = SATISFIED_DEP_PHASES.has(activeTarget.phase);
      const item = {
        task_id: depId,
        title: activeTarget.title || depId,
        phase: activeTarget.phase,
        satisfied: sat,
      };
      resolved.push(item);
      if (!sat) blocking.push(item);
    } else {
      const item = {
        task_id: depId,
        title: depId,
        phase: "missing",
        satisfied: false,
      };
      resolved.push(item);
      blocking.push(item);
    }
  }
  return {
    depends_on: deps,
    resolved_deps: resolved,
    blocking_deps: blocking,
    is_blocked_by_deps: blocking.length > 0,
  };
}

export function computeLeaseStatus(task, eventsNewestFirst = [], receipts = []) {
  const leaseMinutes =
    typeof task.lease_minutes === "number" && task.lease_minutes > 0
      ? task.lease_minutes
      : DEFAULT_LEASE_MINUTES;

  const timestamps = [task.updated_at, task.created_at];
  if (eventsNewestFirst?.[0]?.ts) timestamps.push(eventsNewestFirst[0].ts);
  if (receipts?.[0]?.mtime) timestamps.push(receipts[0].mtime);

  let latestMs = 0;
  let latestIso = task.updated_at || task.created_at || null;
  for (const ts of timestamps) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latestIso = ts;
    }
  }

  const elapsedMinutes = latestMs > 0 ? Math.max(0, Math.floor((Date.now() - latestMs) / 60000)) : 0;
  const activeLeasePhase = task.phase === "in_progress" || task.phase === "in_review";
  const kind = inferKind(task);
  const isStale = activeLeasePhase && kind !== "release" && elapsedMinutes >= leaseMinutes;

  return {
    lease_minutes: leaseMinutes,
    last_heartbeat_at: latestIso,
    elapsed_minutes: elapsedMinutes,
    is_stale: isStale,
  };
}

export function buildUnifiedThread(task, eventsNewestFirst = [], receipts = [], inboxActions = []) {
  const items = [];
  const seenActionIds = new Set();

  const eventsChrono = [...(eventsNewestFirst || [])].reverse();
  eventsChrono.forEach((e, idx) => {
    if (!e || e.type === "idempotency_key_issued") return;
    if (e.action_id) seenActionIds.add(e.action_id);

    const ts = e.ts || task.updated_at || task.created_at;
    if (e.type === "human_message" || e.type === "thread_comment") {
      items.push({
        id: `ev:${idx}:${ts}`,
        ts,
        actor: e.actor || "you",
        role: "human",
        kind: e.steer ? "steer" : "comment",
        title: e.steer ? "Steer → Orchestrator" : "备注",
        body: e.body || e.message || e.note || "",
      });
      return;
    }

    if (e.type === "phase_updated") {
      items.push({
        id: `ev:${idx}:${ts}`,
        ts,
        actor: e.actor || "orchestrator",
        role: e.actor === "you" ? "human" : "orchestrator",
        kind: "phase",
        title: `阶段流转 ${e.from || "?"} → ${e.to || "?"}`,
        body: e.next_step || e.note || "",
      });
      return;
    }

    if (e.type === "thread_bound") {
      const mTag = shortModelTag(e.model);
      items.push({
        id: `ev:${idx}:${ts}`,
        ts,
        actor: mTag || "orchestrator",
        role: e.role || "orchestrator",
        kind: "dispatch",
        title: `绑定 ${e.role || "worker"}${mTag ? ` · ${mTag}` : ""}`,
        body: e.note || e.thread_id || "",
      });
      return;
    }

    if (String(e.type || "").startsWith("dispatch_")) {
      const mTag = shortModelTag(e.model);
      const roleName = String(e.type).replace(/^dispatch_/, "");
      items.push({
        id: `ev:${idx}:${ts}`,
        ts,
        actor: mTag || "orchestrator",
        role: roleName,
        kind: "dispatch",
        title: `派发 ${roleName}${mTag ? ` · ${mTag}` : ""}`,
        body: e.note || e.thread_id || "",
      });
      return;
    }

    if (e.type === "task_initialized") {
      items.push({
        id: `ev:${idx}:${ts}`,
        ts,
        actor: e.actor || "orchestrator",
        role: "system",
        kind: "system",
        title: `创建任务 · ${e.phase || "intake"}`,
        body: e.title || "",
      });
      return;
    }

    if (e.type === "checklist_updated" || e.type === "task_updated" || e.type === "release_completed") {
      items.push({
        id: `ev:${idx}:${ts}`,
        ts,
        actor: e.actor || "you",
        role: e.actor === "orchestrator" ? "orchestrator" : "human",
        kind: e.type === "release_completed" ? "release" : "update",
        title: e.summary || e.type,
        body: e.detail || e.note || "",
      });
      return;
    }

    const detail = [
      e.step_id,
      e.status,
      e.new_head_sha ? `SHA ${String(e.new_head_sha).slice(0, 8)}` : null,
      e.note,
      e.reason,
    ]
      .filter(Boolean)
      .join(" · ");

    items.push({
      id: `ev:${idx}:${ts}`,
      ts,
      actor: shortModelTag(e.model) || e.actor || "orchestrator",
      role: e.role || "orchestrator",
      kind: "event",
      title: String(e.type || "event"),
      body: detail,
    });
  });

  for (const r of receipts || []) {
    const summaryParts = [];
    if (r.head_sha) summaryParts.push(`SHA ${String(r.head_sha).slice(0, 8)}`);
    if (r.checks_total > 0) summaryParts.push(`Checks ${r.checks_pass}/${r.checks_total}`);
    if (r.open_blockers > 0 || r.open_majors > 0 || r.open_minors > 0) {
      summaryParts.push(`Findings ${r.open_blockers}B/${r.open_majors}M/${r.open_minors}m`);
    } else if (r.role === "reviewer") {
      summaryParts.push("0 open findings");
    }
    const body = [summaryParts.join(" · "), r.next_recommendation || ""].filter(Boolean).join("\n");
    items.push({
      id: `receipt:${r.file}`,
      ts: r.mtime,
      actor: r.role || "worker",
      role: r.role || "worker",
      kind: "receipt",
      status: r.status,
      title: `${r.step_id} · ${r.role} · ${String(r.status || "").toUpperCase()}`,
      body,
    });
  }

  for (const a of inboxActions || []) {
    if (!a || a.task_id !== task.task_id || seenActionIds.has(a.id)) continue;
    items.push({
      id: `inbox:${a.id}`,
      ts: a.ts,
      actor: "you",
      role: "human",
      kind: "steer",
      title: `看板触发 · ${a.kind}${a.delivery === "t3-webhook" ? " (Webhook)" : ""}`,
      body: a.note || a.copy_command || "",
    });
  }

  items.sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  return items;
}

export function aggregateReleaseTasks(releaseTask, allActiveTasks) {
  const included = [];
  for (const t of allActiveTasks) {
    if (t.task_id === releaseTask.task_id) continue;
    if (t.project_slug !== releaseTask.project_slug) continue;
    if (inferKind(t) === "release") continue;
    if (t.phase !== "merged_pending_release") continue;
    if (t.release_id && t.release_id !== releaseTask.task_id) continue;

    const prs = getPrUrls(t).map((url) => {
      const m = String(url).match(/\/pull\/(\d+)$/);
      return { url, number: m ? Number(m[1]) : null };
    });
    included.push({
      task_id: t.task_id,
      title: t.title,
      priority: t.priority || "P1",
      prs,
      head_sha: t.pull_request?.head_sha || null,
      has_migration: Boolean(t.has_migration ?? detectMigration(t)),
      updated_at: t.updated_at || null,
      next_step: t.next_step || null,
    });
  }
  included.sort((a, b) => {
    if (a.has_migration !== b.has_migration) return a.has_migration ? -1 : 1;
    return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
  });
  const totalPrs = included.reduce((acc, t) => acc + Math.max(t.prs.length, 0), 0);
  const migrationTasks = included.filter((t) => t.has_migration);
  return {
    included_tasks: included,
    included_task_count: included.length,
    included_pr_count: totalPrs,
    migration_count: migrationTasks.length,
    migration_tasks: migrationTasks.map((t) => ({
      task_id: t.task_id,
      pr_number: t.prs[0]?.number || null,
      title: t.title,
    })),
  };
}

export function archiveTaskDirectory(root, taskId, reason = "completed") {
  const dir = path.join(root, "tasks", "active", taskId);
  const statePath = path.join(dir, "state.json");
  if (!fs.existsSync(statePath)) {
    throw new Error(`Active task "${taskId}" not found at ${statePath}`);
  }
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const ts = nowIso();
  state.phase = "archived";
  state.archived_at = ts;
  state.archive_reason = reason;
  state.updated_at = ts;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");

  const eventsPath = path.join(dir, "events.jsonl");
  fs.appendFileSync(eventsPath, JSON.stringify({ ts, type: "task_archived", reason }) + "\n", "utf8");

  const monthDir = path.join(root, "tasks", "archive", todayStr().slice(0, 7));
  fs.mkdirSync(monthDir, { recursive: true });
  let destDir = path.join(monthDir, taskId);
  if (fs.existsSync(destDir)) {
    let suffix = 2;
    while (fs.existsSync(path.join(monthDir, `${taskId}-${suffix}`))) suffix++;
    destDir = path.join(monthDir, `${taskId}-${suffix}`);
  }
  fs.renameSync(dir, destDir);
  return { task_id: taskId, archived_to: path.relative(root, destDir) };
}

function formatPrLinksMd(state) {
  const prs = getPrUrls(state);
  if (prs.length === 0) return "-";
  return prs
    .map((u) => {
      const m = String(u).match(/\/pull\/(\d+)$/);
      return m ? `[#${m[1]}](${u})` : u;
    })
    .join(", ");
}

function escapeMdCell(text) {
  return String(text || "-")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim() || "-";
}

export function rebuildBoard(root) {
  const allStates = listActiveTaskStates(root);
  const archivedMap = listArchivedIndex(root);
  const archivedCount = archivedMap.size;
  const activeById = new Map(allStates.map((s) => [s.task_id, s]));

  const enriched = allStates.map((s) => {
    const kind = inferKind(s);
    const owner = inferOwner(s);
    const bucket = inferBucket(s);
    const severity = inferSeverity(s, kind);
    const hasMigration = detectMigration(s);
    const depInfo = resolveDependencies(s, activeById, archivedMap);
    return {
      ...s,
      kind,
      owner,
      bucket,
      severity,
      has_migration: hasMigration,
      ...depInfo,
    };
  });

  const backlogItems = enriched.filter((s) => s.phase === "backlog");
  const liveItems = enriched.filter((s) => s.phase !== "backlog");

  // 1) Render tasks/BOARD.md
  const usedIds = new Set();
  const pick = (pred) => {
    const out = [];
    for (const item of liveItems) {
      if (usedIds.has(item.task_id)) continue;
      if (pred(item)) {
        usedIds.add(item.task_id);
        out.push(item);
      }
    }
    return out;
  };

  const needsHuman = pick((s) => s.phase === "needs_human");
  const p0Bugs = pick(
    (s) =>
      s.kind === "bug" &&
      (s.severity === "P0" || s.priority === "P0") &&
      s.phase !== "merged_pending_release" &&
      s.phase !== "completed"
  );
  const inProgress = pick((s) => s.kind !== "release" && s.phase === "in_progress");
  const inReview = pick((s) => s.kind !== "release" && s.phase === "in_review");
  const releases = pick((s) => s.kind === "release" && s.phase !== "merged_pending_release" && s.phase !== "completed");
  const bugsTriage = pick(
    (s) =>
      s.kind === "bug" &&
      s.phase !== "merged_pending_release" &&
      s.phase !== "completed"
  );
  const blocked = pick((s) => s.phase === "blocked");
  const intake = pick((s) => s.phase === "intake");
  const merged = pick((s) => s.phase === "merged_pending_release" || s.phase === "completed");
  const other = pick(() => true);

  const boardLines = [
    "# Local Task Board (Auto-generated by `./scripts/zstack board`)",
    "",
    `> Scope: 统一代码开发任务、开发者 Bug 分诊与发版车次（常规巡检不建卡）。`,
    `> Last rebuilt: ${formatShanghaiTime(new Date(), { withOffset: true })} · Active: ${liveItems.length} · Backlog: ${backlogItems.length} · Archived: ${archivedCount} · Backlog: [BACKLOG.md](./BACKLOG.md)`,
    "",
  ];

  const renderBoardSection = (label, items, { isRelease = false } = {}) => {
    boardLines.push(`## ${label} (${items.length})`, "");
    if (items.length === 0) {
      boardLines.push("_空_", "");
      return;
    }
    if (isRelease) {
      boardLines.push("| Task ID | Project | Phase | Title | Pending PRs | Checklist | Updated |");
      boardLines.push("|---|---|---|---|---|---|---|");
      for (const s of items) {
        const agg = aggregateReleaseTasks(s, enriched);
        const cl = Array.isArray(s.checklist) ? s.checklist : [];
        const clDone = cl.filter((x) => x.done).length;
        const migNote = agg.migration_count > 0 ? ` (含 ${agg.migration_count} DB Migration)` : "";
        const pendingCol = `${agg.included_task_count} tasks / ${agg.included_pr_count} PRs${migNote}`;
        const upd = s.updated_at ? formatShanghaiTime(s.updated_at) : "-";
        boardLines.push(
          `| [\`${s.task_id}\`](./active/${s.task_id}/state.json) | \`${s.project_slug}\` | \`${s.phase}\` | ${escapeMdCell(s.title)} | ${escapeMdCell(pendingCol)} | ${clDone}/${cl.length} | ${upd} |`
        );
      }
      boardLines.push("");
      return;
    }

    boardLines.push("| Task ID | Project | Kind / Pri | Title | PRs | Next Step | Updated |");
    boardLines.push("|---|---|---|---|---|---|---|");
    for (const s of items) {
      const tags = [s.kind, s.severity || s.priority || "-"];
      if (s.has_migration) tags.push("DB");
      if (s.is_blocked_by_deps) tags.push("🔒");
      const upd = s.updated_at ? formatShanghaiTime(s.updated_at) : "-";
      boardLines.push(
        `| [\`${s.task_id}\`](./active/${s.task_id}/state.json) | \`${s.project_slug}\` | \`${tags.join(" · ")}\` | ${escapeMdCell(s.title)} | ${formatPrLinksMd(s)} | ${escapeMdCell(s.next_step)} | ${upd} |`
      );
    }
    boardLines.push("");
  };

  renderBoardSection("待拍板 (Needs Human)", needsHuman);
  if (p0Bugs.length > 0) renderBoardSection("P0 严重缺陷 (P0 Bugs)", p0Bugs);
  renderBoardSection("开发中 (In Progress)", inProgress);
  renderBoardSection("复审中 (In Review)", inReview);
  renderBoardSection("发版车次 (Releases)", releases, { isRelease: true });
  if (bugsTriage.length > 0) renderBoardSection("缺陷分诊池 (Bugs Triage)", bugsTriage);
  renderBoardSection("阻塞 (Blocked)", blocked);
  renderBoardSection("待开工 (Intake)", intake);
  renderBoardSection("已合入待发布 / 待验收 (Merged Pending Release)", merged);
  if (other.length > 0) renderBoardSection("其他状态 (Other)", other);

  const boardPath = path.join(root, "tasks", "BOARD.md");
  fs.writeFileSync(boardPath, boardLines.join("\n"), "utf8");

  // 2) Render tasks/BACKLOG.md from live phase === "backlog" tasks
  const priRank = { P0: 0, P1: 1, P2: 2, P3: 3, "-": 4 };
  const sortBacklog = (arr) =>
    [...arr].sort((a, b) => {
      const pd = (priRank[a.priority] ?? 9) - (priRank[b.priority] ?? 9);
      if (pd !== 0) return pd;
      return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    });

  const mustItems = sortBacklog(backlogItems.filter((s) => s.bucket === "must"));
  const maybeItems = sortBacklog(backlogItems.filter((s) => s.bucket === "maybe"));
  const teamItems = sortBacklog(backlogItems.filter((s) => s.bucket === "team"));

  const backlogLines = [
    "# Task Backlog (Auto-generated by `./scripts/zstack board`)",
    "",
    "> **由 `./scripts/zstack board` 自动生成** — 真实数据源为 `tasks/active/*/state.json`（`phase: \"backlog\"`），请通过看板 UI 或 `./scripts/zstack init-task --phase backlog` 维护，勿手动编辑本文件。",
    `> Last rebuilt: ${formatShanghaiTime(new Date(), { withOffset: true })} · Backlog: ${backlogItems.length} · Active Board: [BOARD.md](./BOARD.md)`,
    "",
    "## My Queue（我亲自实施）",
    "",
    "> Orchestrator 推荐下一个任务时优先看 [BOARD.md](./BOARD.md) 和此区。",
    "",
  ];

  const renderBacklogTable = (heading, items) => {
    backlogLines.push(heading, "");
    if (items.length === 0) {
      backlogLines.push("_空_", "");
      return;
    }
    backlogLines.push("| Task ID | Project | Pri | Title | Notes |");
    backlogLines.push("|---|---|---|---|---|");
    for (const s of items) {
      const depSuffix = s.is_blocked_by_deps
        ? ` [🔒 等待: ${s.blocking_deps.map((d) => d.task_id).join(", ")}]`
        : "";
      const notes = `${s.next_step || "-"}${depSuffix}`;
      backlogLines.push(
        `| [\`${s.task_id}\`](./active/${s.task_id}/state.json) | \`${s.project_slug}\` | ${s.priority || "-"} | \`${escapeMdCell(s.title)}\` | ${escapeMdCell(notes)} |`
      );
    }
    backlogLines.push("");
  };

  renderBacklogTable("### 明确要做", mustItems);
  renderBacklogTable("### 可能亲自做", maybeItems);
  backlogLines.push("## Product / Team Ideas（产品想法 / 团队跟进）", "");
  renderBacklogTable("### 团队想法", teamItems);

  const backlogPath = path.join(root, "tasks", "BACKLOG.md");
  fs.writeFileSync(backlogPath, backlogLines.join("\n"), "utf8");

  return {
    boardPath,
    backlogPath,
    active: liveItems.length,
    backlog: backlogItems.length,
    archived: archivedCount,
  };
}
