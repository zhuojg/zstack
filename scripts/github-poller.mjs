import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getPrUrls, isSafeTaskId, listActiveTaskStates, nowIso } from "./board-core.mjs";

const exec = promisify(execFile);
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const loginPattern = /^[a-z\d][a-z\d-]{0,38}$/i;
const defaults = {
  enabled: true,
  intervalSeconds: 60,
  watchReviewRequested: true,
  watchTrackedPrPush: true,
  watchTrackedPrComments: true,
};

export function writeAtomicJson(file, data) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function normalizeRepo(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/^(?:https:\/\/)?github\.com\//i, "").replace(/\.git$/, "");
  return repoPattern.test(name) ? name.toLowerCase() : null;
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid GitHub config");
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (key === "repos" && Array.isArray(value) && value.every(normalizeRepo)) continue;
    if (key === "login" && typeof value === "string" && loginPattern.test(value)) continue;
    if (key === "intervalSeconds" && Number.isInteger(value) && value >= 1 && value <= 86400) continue;
    if (typeof defaults[key] === "boolean" && typeof value === "boolean") continue;
    throw new Error(`Invalid GitHub config field: ${key}`);
  }
  return config;
}

async function gh(args) {
  try {
    return { ...await exec("gh", ["api", "--hostname", "github.com", ...args], {
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", CLICOLOR_FORCE: "0", GH_FORCE_TTY: "" },
    }), failed: false };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("GitHub CLI (gh) is not installed");
    if (error.killed) throw new Error("GitHub request timed out");
    return { stdout: error.stdout || "", stderr: error.stderr || "", failed: true };
  }
}

function emptyCursor(login = null) {
  return {
    login, lastSyncAt: null, lastError: null, etags: {}, seenEvents: {},
    prHeads: {}, prLatestCommentId: {}, baselines: {}, recentEvents: [],
    stats: { notModified: 0, responses: 0, events: 0 },
  };
}

export function createGitHubPoller({ root, loadProjects, emit }) {
  const cache = path.join(root, ".zstack-cache");
  const cursorFile = path.join(cache, "github-cursor.json");
  const configFile = path.join(cache, "github-watch.json");
  let cursor = emptyCursor();
  let lastError = null;
  try {
    cursor = { ...cursor, ...readJson(cursorFile, {}) };
  } catch {
    lastError = "GitHub cursor could not be read";
  }
  let cursorReadable = !lastError;
  let timer;
  let running;
  let started = false;
  let failures = 0;
  let retryAt = 0;
  let authenticatedLogin;
  let generation = 0;

  function config() {
    const stored = validateConfig(readJson(configFile, {}));
    const projects = loadProjects();
    const projectByRepo = Object.fromEntries(Object.values(projects)
      .map(project => [normalizeRepo(project.canonical_repo), project.slug]).filter(([repo]) => repo));
    return {
      ...defaults, ...stored,
      repos: [...new Set((stored.repos || Object.keys(projectByRepo)).map(normalizeRepo))],
      projectByRepo,
    };
  }

  function status() {
    let settings = defaults;
    let error = lastError;
    try {
      settings = config();
    } catch (err) {
      error = `GitHub configuration error: ${err.message}`;
    }
    const { projectByRepo, ...visible } = settings;
    return {
      ...visible, repos: visible.repos || [], login: visible.login || authenticatedLogin || cursor.login,
      running: Boolean(running), lastSyncAt: cursor.lastSyncAt, lastError: error,
      state: !settings.enabled ? "paused" : error ? "degraded" : cursor.lastSyncAt ? "active" : "starting",
      retryAt: retryAt > Date.now() ? new Date(retryAt).toISOString() : null,
      stats: cursor.stats, recentEvents: cursor.recentEvents,
      launchd: { managed: process.platform === "darwin" && process.env.ZSTACK_LAUNCHD_LABEL === "dev.zstack.daemon" },
      pid: process.pid,
    };
  }

  async function request(endpoint, counts) {
    const cached = cursor.etags[endpoint];
    const args = ["--include", endpoint];
    if (cached?.etag) args.push("-H", `If-None-Match: ${cached.etag}`);
    const { stdout, stderr, failed } = await gh(args);
    const [head, ...rest] = stdout.split(/\r?\n\r?\n/);
    const code = Number(head.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
    const headers = new Map(head.split(/\r?\n/).slice(1).map(line => {
      const sep = line.indexOf(":");
      return [line.slice(0, sep).toLowerCase(), line.slice(sep + 1).trim()];
    }));
    if (code === 304 && cached?.etag) {
      counts.notModified++;
      return { unchanged: true, next: cached.next };
    }
    if (code === 429 || code === 403) {
      const retryAfter = Number(headers.get("retry-after")) * 1000 || 0;
      const reset = headers.get("x-ratelimit-remaining") === "0"
        ? Number(headers.get("x-ratelimit-reset")) * 1000 : 0;
      if (code === 429 || retryAfter || reset || /secondary rate limit/i.test(stderr)) retryAt = Math.max(retryAt, reset, Date.now() + Math.max(60000, retryAfter));
    }
    if (failed || code !== 200) throw new Error(`GitHub ${endpoint.split("?")[0]}: ${code || "request failed"}`);
    counts.responses++;
    const nextUrl = headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    let next = null;
    if (nextUrl) {
      const url = new URL(nextUrl);
      if (url.origin !== "https://api.github.com") throw new Error("Unexpected GitHub pagination host");
      next = url.pathname.slice(1) + url.search;
    }
    return { data: JSON.parse(rest.join("\n\n")), etag: headers.get("etag") || null, next };
  }

  async function checkStream(key, endpoint, counts, handle, stillCurrent) {
    const updates = {};
    const items = [];
    const visited = new Set();
    while (endpoint && stillCurrent()) {
      if (visited.has(endpoint)) throw new Error("GitHub pagination repeated an endpoint");
      visited.add(endpoint);
      const page = await request(endpoint, counts);
      if (!page.unchanged) {
        items.push(...(Array.isArray(page.data) ? page.data : [page.data]));
        updates[endpoint] = { etag: page.etag, next: page.next };
      }
      endpoint = page.next;
    }
    if (!stillCurrent()) return;
    await handle(items, !cursor.baselines[key]);
    if (!stillCurrent()) return;
    Object.assign(cursor.etags, updates);
    cursor.baselines[key] = true;
    writeAtomicJson(cursorFile, cursor);
  }

  async function run(currentGeneration) {
    const counts = { notModified: 0, responses: 0, events: 0 };
    const stillCurrent = () => started && generation === currentGeneration;
    const report = () => ({
      ...counts, allNotModified: counts.notModified > 0 && counts.responses === 0 && !lastError,
      state: status().state, error: lastError,
    });
    try {
      const cfg = config();
      if (!cfg.enabled || Date.now() < retryAt) return report();
      if (!cursorReadable) {
        cursor = { ...emptyCursor(), ...readJson(cursorFile, {}) };
        cursorReadable = true;
      }
      if (!authenticatedLogin) {
        const user = await gh(["user", "--jq", ".login"]);
        if (user.failed || !loginPattern.test(user.stdout.trim())) {
          throw new Error("GitHub login could not be verified. Check gh auth status and connectivity.");
        }
        authenticatedLogin = user.stdout.trim().toLowerCase();
      }
      const login = cfg.login?.toLowerCase() || authenticatedLogin;
      if (!stillCurrent()) return report();
      if (cursor.login !== login || cursor.authenticatedLogin !== authenticatedLogin) {
        cursor = { ...emptyCursor(login), authenticatedLogin };
      }
      const tracked = new Map();
      const activeUrls = new Set();
      for (const task of listActiveTaskStates(root)) {
        for (const url of getPrUrls(task)) {
          const match = String(url).match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i);
          if (!match) continue;
          const slug = match[1].toLowerCase();
          const key = `${slug}#${match[2]}`;
          activeUrls.add(key);
          if (["done", "merged_pending_release"].includes(task.phase) || !isSafeTaskId(task.task_id)) continue;
          if (!cfg.repos.includes(slug)) continue;
          if (!tracked.has(key)) tracked.set(key, []);
          tracked.get(key).push(task);
        }
      }
      const errors = [];
      const syncStream = async (...args) => {
        if (!stillCurrent() || Date.now() < retryAt) return;
        try {
          await checkStream(...args, stillCurrent);
        } catch (error) {
          errors.push(error.message);
        }
      };
      const notify = async (kind, key, details, baseline) => {
        const id = `${kind}:${key}`;
        if (!stillCurrent() || cursor.seenEvents[id]) return;
        if (!baseline) {
          const ts = nowIso();
          const event = { kind, source: "github-poller", event_key: id, ...details };
          const result = await emit(event);
          cursor.recentEvents.unshift({ ...event, ts, delivery: result.action.delivery });
          cursor.recentEvents = cursor.recentEvents.slice(0, 20);
          counts.events++;
        }
        cursor.seenEvents[id] = nowIso();
      };
      for (const repo of cfg.repos) {
        if (!cfg.watchReviewRequested) break;
        const stream = `review:${repo}`;
        await syncStream(stream, `repos/${repo}/pulls?state=open&per_page=100`, counts, async (prs, baseline) => {
          for (const pr of prs) {
            if (!Number.isSafeInteger(pr.number) || !/^[a-f0-9]{40}$/i.test(pr.head?.sha)) continue;
            const people = [...(pr.assignees || []), ...(pr.requested_reviewers || [])];
            if (!people.some(person => person.login?.toLowerCase() === login)) continue;
            const key = `${repo}#${pr.number}`;
            await notify("github_pr_review_requested", `${key}@${pr.head.sha}`, {
              pr_url: `https://github.com/${repo}/pull/${pr.number}`, pr_number: pr.number,
              head_sha: pr.head.sha, project_slug: cfg.projectByRepo[repo] || null,
            }, baseline || activeUrls.has(key));
          }
        });
      }
      for (const [key, tasks] of tracked) {
        const [repo, number] = key.split("#");
        const prDetails = { pr_url: `https://github.com/${repo}/pull/${number}`, pr_number: Number(number) };
        const pull = `repos/${repo}/pulls/${number}`;
        if (cfg.watchTrackedPrPush) {
          await syncStream(`head:${key}`, pull, counts, async ([pr]) => {
            const sha = pr?.head?.sha;
            if (!/^[a-f0-9]{40}$/i.test(sha)) return;
            for (const task of tasks) {
              const taskKey = `${task.task_id}:${key}`;
              const previous = cursor.prHeads[taskKey];
              if (previous !== sha) {
                await notify("github_pr_synchronized", `${task.task_id}@${sha}`, {
                  ...prDetails, task_id: task.task_id, project_slug: task.project_slug, head_sha: sha,
                }, !previous || pr.state !== "open");
                if (stillCurrent()) cursor.prHeads[taskKey] = sha;
              }
            }
          });
        }
        if (!cfg.watchTrackedPrComments) continue;
        for (const [type, endpoint] of [
          ["issue", `repos/${repo}/issues/${number}/comments`],
          ["review_comment", `${pull}/comments`],
          ["review", `${pull}/reviews`],
        ]) {
          const stream = `comment:${key}:${type}`;
          await syncStream(stream, `${endpoint}?per_page=100`, counts, async (comments, baseline) => {
            for (const comment of comments) {
              if (!Number.isSafeInteger(comment.id) || !comment.user?.login) continue;
              if (type === "review" && (!comment.submitted_at || !comment.body?.trim())) continue;
              const own = comment.user.login.toLowerCase() === login;
              await notify("github_pr_commented", `${key}:${type}:${comment.id}`, {
                ...prDetails, task_id: tasks[0].task_id, project_slug: tasks[0].project_slug,
                comment_id: comment.id, comment_type: type,
              }, baseline || own);
              cursor.prLatestCommentId[stream] = Math.max(cursor.prLatestCommentId[stream] || 0, comment.id);
            }
          });
        }
      }
      if (!stillCurrent()) return report();
      if (errors.length) throw new Error(errors[0]);
      cursor.lastSyncAt = nowIso();
      lastError = null;
      failures = 0;
      retryAt = 0;
    } catch (error) {
      lastError = error.message;
      failures++;
    }
    for (const key of Object.keys(counts)) cursor.stats[key] += counts[key];
    cursor.lastError = lastError;
    if (cursorReadable) {
      try {
        writeAtomicJson(cursorFile, cursor);
      } catch {
        lastError = "GitHub cursor could not be written";
        failures++;
      }
    }
    return report();
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (!started) return;
    const settings = status();
    if (!settings.enabled) return;
    const interval = settings.intervalSeconds * 1000;
    const backoff = failures ? Math.min(Math.max(interval, 3600000), interval * 2 ** Math.min(failures, 10)) : interval;
    timer = setTimeout(sync, Math.max(delay ?? backoff, retryAt - Date.now()));
    timer.unref();
  }

  function sync() {
    if (!running) {
      clearTimeout(timer);
      running = run(generation).finally(() => {
        running = null;
        schedule();
      });
    }
    return running;
  }

  return {
    status, sync,
    start() {
      started = true;
      schedule(0);
    },
    stop() {
      started = false;
      generation++;
      clearTimeout(timer);
    },
    update(patch) {
      try {
        validateConfig(patch);
        if (Object.keys(patch).some(key => !["enabled", "intervalSeconds"].includes(key))) {
          throw new Error("Only enabled and intervalSeconds can be changed through the dashboard");
        }
      } catch (error) {
        error.statusCode = 400;
        throw error;
      }
      writeAtomicJson(configFile, { ...validateConfig(readJson(configFile, {})), ...patch });
      if (patch.enabled !== undefined) generation++;
      schedule(patch.enabled ? 0 : undefined);
      return status();
    },
  };
}
