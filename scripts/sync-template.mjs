#!/usr/bin/env node
/**
 * Repeatable, zero-leak template exporter & publisher for zstack.
 *
 * Exports ONLY the whitelisted generic framework layer plus clean skeleton files,
 * sanitizes personal/company paths and transforms guard-policy.mjs into a portable
 * out-of-the-box version, runs a fail-closed secret + sensitive-term leak gate,
 * and (with --push) pushes an independent history-free commit to the template repo.
 *
 * Usage:
 *   ./scripts/zstack sync-template [--dry-run] [--out <dir>] [--push] [--remote <url_or_name>] [--branch <name>] [--config <path>]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, "..");

const WHITELIST_ENTRIES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  ".gitignore",
  "policies",
  "roles",
  "skills",
  "schemas",
  "scripts",
  "tests",
  ".agents",
  ".claude",
  ".codex",
  "projects/_template",
];

const FALLBACK_SECRET_RULES = [
  { name: "GitHub PAT", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "GitHub Fine-Grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "OpenAI / Anthropic API Key", re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Private Key Block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "Bearer Token", re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
  { name: "Mainland China Mobile PII", re: /(?:(?<![0-9A-Za-z])|(?<=\+86))1[3-9]\d{9}(?![0-9A-Za-z])/g },
  { name: "DB / Cache Credential URL", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/(?!<)[^/\s:@"'`<>]+:(?!<|\*|\$\{)[^/\s@"'`<>]{4,}@[^\s"'`<>]+/gi },
  { name: "S3 / OSS Presigned URL Signature", re: /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|OSSAccessKeyId|Signature)=[A-Za-z0-9%_+/=-]{12,}/gi },
  { name: "Webhook / API Secret Query URL", re: /https?:\/\/[^\s"'`<>]+\?(?:[^\s"'`<>]*&)?(?:token|key|secret|api_key|apikey|access_token|webhook_secret)=(?!<|\*|\$\{)[A-Za-z0-9._~%+/=-]{8,}/gi },
];

const BUILTIN_FORBIDDEN_PATTERNS = [
  { name: "Absolute macOS home path", re: /\/Users\/[A-Za-z0-9._-]+\//g },
];

function fail(msg) {
  console.error(`[zstack sync-template] ERROR: ${msg}`);
  process.exit(1);
}

function sleepSync(ms) {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

function execGit(args, { cwd, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      lastErr = err;
      const stderr = String(err.stderr || err.message || "");
      const transient = /TLS|handshake|timeout|Connection closed|EOF|reset by peer|Could not resolve|502|503|504/i.test(stderr);
      if (attempt < retries && transient) {
        sleepSync(attempt * 2000);
        continue;
      }
      if (attempt < retries) {
        sleepSync(attempt * 1500);
        continue;
      }
    }
  }
  const msg = String(lastErr?.stderr || lastErr?.message || lastErr);
  throw new Error(`git ${args.join(" ")} failed: ${msg.trim()}`);
}

function parseArgs(rawArgs) {
  const opts = {
    dryRun: false,
    out: null,
    push: false,
    remote: null,
    branch: "main",
    config: null,
    message: null,
  };
  const requireVal = (flag, idx) => {
    if (idx >= rawArgs.length) fail(`Missing value for flag "${flag}"`);
    return rawArgs[idx];
  };
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--push") opts.push = true;
    else if (a === "--out") opts.out = requireVal(a, ++i);
    else if (a === "--remote") opts.remote = requireVal(a, ++i);
    else if (a === "--branch") opts.branch = requireVal(a, ++i);
    else if (a === "--config") opts.config = requireVal(a, ++i);
    else if (a === "--message") opts.message = requireVal(a, ++i);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: zstack sync-template [--dry-run] [--out <dir>] [--push] [--remote <url_or_name>] [--branch <name>] [--config <path>] [--message <msg>]"
      );
      process.exit(0);
    } else {
      fail(`Unknown argument "${a}". Supported: --dry-run, --out <dir>, --push, --remote <url_or_name>, --branch <name>, --config <path>, --message <msg>`);
    }
  }
  if (opts.dryRun && opts.push) {
    fail("--dry-run and --push cannot be combined");
  }
  return opts;
}

function hasPrivateProjects(root) {
  const projectsDir = path.join(root, "projects");
  if (!fs.existsSync(projectsDir)) return false;
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "_template" || entry.name === "example") continue;
    return true;
  }
  return false;
}

function loadPrivateConfig(root, customConfigPath) {
  const configPath = customConfigPath
    ? path.isAbsolute(customConfigPath)
      ? customConfigPath
      : path.resolve(root, customConfigPath)
    : path.join(root, "projects", "sync-template.private.json");

  if (!fs.existsSync(configPath)) {
    if (customConfigPath) {
      fail(`Config file not found: ${configPath}`);
    }
    if (hasPrivateProjects(root)) {
      fail(
        `Private project directories detected under projects/, but required private sync config is missing at ${path.relative(root, configPath)}. Aborting fail-closed to prevent data leaks.`
      );
    }
    return { replacements: [], forbiddenPatterns: [...BUILTIN_FORBIDDEN_PATTERNS], configPath: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    fail(`Invalid JSON in ${configPath}: ${e.message}`);
  }

  const replacements = (parsed.replacements || []).map((r) => ({
    re: new RegExp(r.pattern, r.flags || "g"),
    replacement: r.replacement,
  }));
  const forbiddenPatterns = [
    ...BUILTIN_FORBIDDEN_PATTERNS,
    ...(parsed.forbidden_patterns || []).map((p) => ({
      name: p.name || p.pattern,
      re: new RegExp(p.pattern, p.flags || "i"),
    })),
  ];

  if (hasPrivateProjects(root) && (parsed.forbidden_patterns || []).length === 0) {
    fail(`Private sync config ${path.relative(root, configPath)} must define non-empty forbidden_patterns.`);
  }

  return { replacements, forbiddenPatterns, configPath };
}

function transformGuardPolicy(content) {
  let out = content;
  const envLoaderSnippet = [
    "function loadEnvProductPrefixes() {",
    '  const raw = process.env.ZSTACK_FORBIDDEN_PRODUCT_PREFIXES || "";',
    "  return raw",
    "    .split(/[:,]/)",
    "    .map((s) => s.trim())",
    "    .filter(Boolean)",
    '    .map((p) => (p.startsWith("~/") ? path.resolve(process.env.HOME || "", p.slice(2)) : path.resolve(p)));',
    "}",
    "",
    "function escapeRegExp(str) {",
    '  return str.replace(/[.*+?^$()|[\\]\\\\{}]/g, "\\\\$&");',
    "}",
  ].join("\n");
  out = out.replace(/const DEFAULT_FORBIDDEN_PRODUCT_PREFIXES = \[[\s\S]*?\];/, () => envLoaderSnippet);
  out = out.replace(
    /const prefixes = new Set\(DEFAULT_FORBIDDEN_PRODUCT_PREFIXES\);/,
    () => `const prefixes = new Set(loadEnvProductPrefixes());`
  );
  out = out.replace(
    /\{\s*re:\s*\/\\bgit\\s\+-C\\s\+\(\?!\\\.\\\/\|\[[^\]]+\]\?[^)]+\)\/,\s*label:\s*"git -C targeting external repository"\s*\},/,
    () =>
      `{ re: new RegExp("\\\\bgit\\\\s+-C\\\\s+(?!\\\\.\\\\/|['\\\\\\"]?" + escapeRegExp(ZSTACK_ROOT) + ")"), label: "git -C targeting external repository" },`
  );
  return out;
}

function transformReadme(content) {
  let out = content;
  out = out.replace(
    /> \*\*Private Repository\*\*:[^\n]*/,
    `> **Template Repository**: Generic, zero-secret control-plane template for T3 Code. Click **Use this template** to create your own private \`zstack-private\` repository for personal projects, tasks, and curated memory. Never commit secrets, tokens, raw production logs, or customer PII.`
  );
  if (!out.includes("sync-template")) {
    out = out.replace(
      /\.\/scripts\/zstack check-secrets\n```/,
      `./scripts/zstack check-secrets\n./scripts/zstack sync-template --dry-run\n\`\`\``
    );
  }
  return out;
}

function sanitizeText(relPath, content, replacements) {
  let out = content;
  if (relPath === "scripts/guard-policy.mjs") {
    out = transformGuardPolicy(out);
  } else if (relPath === "README.md") {
    out = transformReadme(out);
  } else if (relPath === "scripts/board-core.mjs") {
    out = out.replace(
      /export function defaultReleaseChecklist\(projectSlug\) \{\n  if \(projectSlug === "[a-z0-9-]+"\) \{\n[\s\S]*?\n  \}/,
      "export function defaultReleaseChecklist() {"
    );
  } else if (relPath === "scripts/dashboard-server.mjs") {
    out = out
      .replace(/(action\.project_slug \|\| )"[a-z0-9-]+"/g, '$1"-"')
      .replace(/(Object\.keys\(projects\)\[0\] \|\| )"[a-z0-9-]+"/, '$1"example"')
      .replace(/project_slug: body\.project \|\| body\.project_slug \|\| "[a-z0-9-]+",/, "project_slug: body.project || body.project_slug,")
      .replace(/(body\.project_slug \|\| )"[a-z0-9-]+"/, '$1Object.keys(loadProjects(root))[0] || "example"');
  } else if (relPath === "scripts/dashboard-ui.html") {
    out = out
      .replace(/(state\.project \|\| getProjectSlugs\(\)\[0\] \|\| )"[a-z0-9-]+"/, '$1"example"')
      .replace(/placeholder="例如：[^"]+ SaaS 发版车次"/, 'placeholder="例如：v1.0.0 发版车次"')
      .replace(/placeholder="例如：\d+ 或 https:\/\/github\.com\/[^"]+"/, 'placeholder="例如：123 或 https://github.com/owner/repo/pull/123"')
      .replace(/placeholder="例如：[a-z0-9]+-core-[a-z0-9-]+"/, 'placeholder="例如：example-core-update"')
      .replace(
        /(const isNum = \/\^\\d\+\$\/\.test\(raw\);)([\s\S]*?pr_url: isNum \? .)https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\$\{raw\}/,
        (_match, numberCheck, actionPrefix) => [
          numberCheck,
          '            const canonicalRepo = state.snapshot?.projects?.find((p) => p.slug === defaultProj)?.canonical_repo || "";',
          '            const repo = canonicalRepo.match(/^(?:https:\\/\\/)?github\\.com\\/([\\w.-]+\\/[\\w.-]+?)(?:\\.git)?\\/?$/i)?.[1];',
          '            if (isNum && !repo) { showToast("请提供完整 PR URL", "", "warn"); return; }',
        ].join("\n") + actionPrefix + "https://github.com/${repo}/pull/${raw}"
      );
  }
  for (const { re, replacement } of replacements) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

function copyWhitelistedEntry(root, destRoot, relEntry, replacements, exportedFiles) {
  const srcPath = path.join(root, relEntry);
  if (!fs.existsSync(srcPath)) {
    try {
      fs.lstatSync(srcPath);
    } catch {
      return;
    }
  }

  const stat = fs.lstatSync(srcPath);
  const destPath = path.join(destRoot, relEntry);

  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(srcPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.symlinkSync(linkTarget, destPath);
    exportedFiles.push({ path: relEntry, type: "symlink", target: linkTarget });
    return;
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(destPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", ".zstack-cache", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      const childRel = path.posix.join(relEntry.split(path.sep).join("/"), entry.name);
      copyWhitelistedEntry(root, destRoot, childRel, replacements, exportedFiles);
    }
    return;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const raw = fs.readFileSync(srcPath, "utf8");
  const normalizedRel = relEntry.split(path.sep).join("/");
  const sanitized = sanitizeText(normalizedRel, raw, replacements);
  fs.writeFileSync(destPath, sanitized, { encoding: "utf8", mode: stat.mode & 0o777 });
  exportedFiles.push({ path: normalizedRel, type: "file" });
}

function writeSkeletonFiles(destRoot, exportedFiles) {
  const skeletons = [
    {
      rel: "projects/example/project.yaml",
      content: `schema_version: 1
slug: "example"
display_name: "Example Application"
owner: "<your-github-handle>"
policy_version: "2026-01-01"
last_verified_at: "2026-01-01"

t3:
  project_id: "<t3-project-uuid>"
  environment_id: "<t3-environment-uuid>"
  workspace_root_ref: "/path/to/your-product-repos/example-app" # Metadata reference only; Orchestrator MUST NOT read/write this path

repository:
  canonical: "github.com/example-org/example-app"
  default_branch: "origin/main"
  trusted_remotes:
    origin:
      url: "git@github.com:example-org/example-app.git"
      role: "primary_pr"
      allow_push_branches: true
      allow_push_default: false

capabilities:
  implement:
    allowed: true
    requires_worktree: true
    default_provider: "codex"
    default_model: "gpt-6.2-sol"
  review:
    allowed: true
    independent_thread_required: true
    must_pin_head_sha: true
    max_rounds: 3
    default_provider: "antigravity"
    default_model: "gemini-4-neon"
  merge:
    policy: "auto_merge_on_gate_pass" # auto_merge_on_gate_pass | human_approval_required
    requires_independent_review_pass_on_head_sha: true
  deploy:
    policy: "forbidden_by_default"

environments:
  local:
    access: "read_write_in_worktree"

repo_sop_refs:
  repo_agents_md: "AGENTS.md"

zstack_sops: []
`,
    },
    {
      rel: "memory/preferences.md",
      content: `# User Preferences

Durable workflow preferences. Changes here require explicit user confirmation (see \`policies/memory-governance.md\`).

\`\`\`yaml
id: "mem-pref-0001"
scope: "global"
kind: "preference"
confidence: "verified"
summary: "Default to high-autonomy delivery with independent fixed-SHA review and deterministic merge-gate; pause only for production mutations, destructive remote git operations, or 3 non-converging review rounds."
source: "template:default"
created_at: "2026-01-01"
verified_at: "2026-01-01"
ttl_days: 180
status: "active"
superseded_by: null
\`\`\`
`,
    },
    {
      rel: "memory/facts/global.md",
      content: `# Global Engineering & T3 Facts

Record durable cross-project facts and pitfalls here, then run \`./scripts/zstack reindex\`.

\`\`\`yaml
id: "mem-global-0001"
scope: "global"
kind: "fact"
confidence: "verified"
summary: "Use watch_pull_request for external PR status transitions instead of polling with timers; reserve one-shot schedule_task fallbacks for long-running pre-PR implementation tasks."
source: "template:default"
created_at: "2026-01-01"
verified_at: "2026-01-01"
ttl_days: 90
status: "active"
superseded_by: null
\`\`\`
`,
    },
    {
      rel: "memory/INDEX.md",
      content: `# Memory Index (Auto-generated by \`./scripts/zstack reindex\`)

Last rebuilt: 2026-01-01 · Total entries: 2

| ID | Scope | Kind | Confidence | Status | Verified | Summary | Source File |
|---|---|---|---|---|---|---|---|
| \`mem-pref-0001\` | \`global\` | preference | verified | \`active\` | 2026-01-01 | Default to high-autonomy delivery with independent fixed-SHA review and deterministic merge-gate; pause only for production mutations, destructive remote git operations, or 3 non-converging review rounds. | \`memory/preferences.md\` |
| \`mem-global-0001\` | \`global\` | fact | verified | \`active\` | 2026-01-01 | Use watch_pull_request for external PR status transitions instead of polling with timers; reserve one-shot schedule_task fallbacks for long-running pre-PR implementation tasks. | \`memory/facts/global.md\` |
`,
    },
    {
      rel: "tasks/BOARD.md",
      content: `# Local Task Board (Auto-generated by \`./scripts/zstack board\`)

> Scope: Track active code features and bug-fix tasks only. Run \`./scripts/zstack board\` to rebuild from \`tasks/active/*/state.json\`.
> Active: 0 · Archived: 0 · Backlog: [BACKLOG.md](./BACKLOG.md)

## 开发中 (In Progress) (0)

_空_

## 复审中 (In Review) (0)

_空_

## 阻塞 / 待拍板 (Blocked) (0)

_空_

## 待开工 (Intake) (0)

_空_

## 已合入待发布 / 待验收 (Merged Pending Release) (0)

_空_
`,
    },
    {
      rel: "tasks/BACKLOG.md",
      content: `# Task Backlog (Parked / To-Investigate Code Ideas)

> Store unstarted code ideas here. Once started, initialize a card with \`./scripts/zstack init-task <task-id> <project-slug> "<title>"\` so it enters \`tasks/active/\` and appears in [BOARD.md](./BOARD.md).

## My Queue

| Project | Pri | Title | Notes |
|---|---|---|---|
| \`example\` | P1 | \`sample-task\` | Replace with your own queued development items |

## Product / Team Ideas

| Project | Pri | Title | Notes |
|---|---|---|---|
| \`example\` | - | \`sample-team-idea\` | Ideas parked for future triage or team delegation |
`,
    },
    {
      rel: "tasks/active/.gitkeep",
      content: "",
    },
    {
      rel: "tasks/archive/.gitkeep",
      content: "",
    },
  ];

  for (const item of skeletons) {
    const destPath = path.join(destRoot, item.rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, item.content, "utf8");
    exportedFiles.push({ path: item.rel, type: "skeleton" });
  }
}

function walkExportTree(rootDir, curDir = rootDir, out = []) {
  for (const entry of fs.readdirSync(curDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git") continue;
    const full = path.join(curDir, entry.name);
    const rel = path.relative(rootDir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      out.push({ full, rel, isSymlink: true, target: fs.readlinkSync(full) });
    } else if (entry.isDirectory()) {
      walkExportTree(rootDir, full, out);
    } else {
      out.push({ full, rel, isSymlink: false });
    }
  }
  return out;
}

function runLeakGate(targetDir, { secretRules, forbiddenPatterns }) {
  const entries = walkExportTree(targetDir);
  const hits = [];

  for (const entry of entries) {
    if (entry.isSymlink) {
      for (const rule of forbiddenPatterns) {
        rule.re.lastIndex = 0;
        const m = entry.target.match(rule.re);
        if (m) {
          hits.push({ file: entry.rel, line: 0, rule: `Forbidden term in symlink: ${rule.name}`, match: m[0] });
        }
      }
      continue;
    }

    const content = fs.readFileSync(entry.full, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (entry.rel !== "scripts/zstack") {
        for (const rule of secretRules) {
          rule.re.lastIndex = 0;
          if (rule.re.test(line)) {
            hits.push({ file: entry.rel, line: i + 1, rule: `Secret/PII: ${rule.name}` });
          }
        }
      }
      for (const rule of forbiddenPatterns) {
        rule.re.lastIndex = 0;
        const m = line.match(rule.re);
        if (m) {
          hits.push({ file: entry.rel, line: i + 1, rule: `Forbidden term: ${rule.name}`, match: m[0] });
        }
      }
    }
  }

  return {
    passed: hits.length === 0,
    scanned_files: entries.length,
    hits,
  };
}

function resolveRemoteUrl(root, remoteArg) {
  const candidate = remoteArg || "template";
  if (/^(https?:\/\/|git@|ssh:\/\/|file:\/\/|\/)/.test(candidate)) {
    return candidate;
  }
  try {
    return execGit(["remote", "get-url", candidate], { cwd: root });
  } catch {
    fail(`Could not resolve git remote "${candidate}". Pass --remote <url> or configure "git remote add template <url>".`);
  }
}

function syncDirectoryContents(srcDir, dstDir) {
  for (const entry of fs.readdirSync(dstDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    fs.rmSync(path.join(dstDir, entry.name), { recursive: true, force: true });
  }
  const copyRecursive = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const s = path.join(from, entry.name);
      const d = path.join(to, entry.name);
      const st = fs.lstatSync(s);
      if (st.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(s), d);
      } else if (st.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyRecursive(s, d);
      } else {
        fs.copyFileSync(s, d);
        fs.chmodSync(d, st.mode & 0o777);
      }
    }
  };
  copyRecursive(srcDir, dstDir);
}

function publishToRemote(stagingDir, { root, remoteUrl, branch, message, secretRules, forbiddenPatterns }) {
  const repoTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zstack-template-push-"));
  try {
    const lsRemoteOut = execGit(["ls-remote", "--heads", remoteUrl, branch], { cwd: repoTempDir, retries: 3 });
    const branchExists = lsRemoteOut.length > 0;

    if (branchExists) {
      execGit(["clone", "--depth", "1", "--branch", branch, "--single-branch", remoteUrl, "."], {
        cwd: repoTempDir,
        retries: 3,
      });
      const existingEntries = fs.readdirSync(repoTempDir).filter((n) => n !== ".git");
      const looksLikeTemplate =
        existingEntries.length === 0 ||
        fs.existsSync(path.join(repoTempDir, "AGENTS.md")) ||
        fs.existsSync(path.join(repoTempDir, "scripts", "zstack"));
      if (!looksLikeTemplate) {
        fail(`Refusing to overwrite non-template repository contents at ${remoteUrl} (${branch}).`);
      }
    } else {
      execGit(["init", "-b", branch], { cwd: repoTempDir });
      execGit(["remote", "add", "origin", remoteUrl], { cwd: repoTempDir });
    }

    syncDirectoryContents(stagingDir, repoTempDir);

    const finalGate = runLeakGate(repoTempDir, { secretRules, forbiddenPatterns });
    if (!finalGate.passed) {
      console.log(JSON.stringify({ ok: false, stage: "pre_push_leak_gate", hits: finalGate.hits }, null, 2));
      process.exit(1);
    }

    execGit(["add", "-A"], { cwd: repoTempDir });
    const status = execGit(["status", "--porcelain"], { cwd: repoTempDir });
    if (!status) {
      const headSha = branchExists ? execGit(["rev-parse", "HEAD"], { cwd: repoTempDir }) : null;
      return { pushed: false, up_to_date: true, commit_sha: headSha, branch_existed: branchExists };
    }

    let userName = "zstack-bot";
    let userEmail = "zstack-bot@users.noreply.github.com";
    try {
      const n = execGit(["config", "user.name"], { cwd: root });
      const e = execGit(["config", "user.email"], { cwd: root });
      if (n) userName = n;
      if (e) userEmail = e;
    } catch {
      // use defaults
    }

    execGit(["config", "user.name", userName], { cwd: repoTempDir });
    execGit(["config", "user.email", userEmail], { cwd: repoTempDir });

    const commitMsg = message || "chore(template): sync sanitized zstack template";
    execGit(["commit", "-m", commitMsg], { cwd: repoTempDir });
    const commitSha = execGit(["rev-parse", "HEAD"], { cwd: repoTempDir });
    execGit(["push", "-u", "origin", branch], { cwd: repoTempDir, retries: 3 });

    return { pushed: true, up_to_date: false, commit_sha: commitSha, branch_existed: branchExists };
  } finally {
    fs.rmSync(repoTempDir, { recursive: true, force: true });
  }
}

export async function runSyncTemplate(rawArgs, { root = DEFAULT_ROOT, secretRules = FALLBACK_SECRET_RULES } = {}) {
  const opts = parseArgs(rawArgs);
  const { replacements, forbiddenPatterns, configPath } = loadPrivateConfig(root, opts.config);

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "zstack-template-export-"));
  const exportedFiles = [];
  try {
    for (const entry of WHITELIST_ENTRIES) {
      copyWhitelistedEntry(root, stagingDir, entry, replacements, exportedFiles);
    }
    writeSkeletonFiles(stagingDir, exportedFiles);

    const leakGate = runLeakGate(stagingDir, { secretRules, forbiddenPatterns });
    if (!leakGate.passed) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            stage: "export_leak_gate",
            scanned_files: leakGate.scanned_files,
            hits: leakGate.hits,
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    const result = {
      ok: true,
      mode: opts.push ? "push" : opts.out ? "export" : "dry-run",
      config_used: configPath ? path.relative(root, configPath) : null,
      files_exported: exportedFiles.length,
      leak_gate: leakGate,
    };

    if (opts.out) {
      const absOut = path.isAbsolute(opts.out) ? opts.out : path.resolve(root, opts.out);
      fs.mkdirSync(absOut, { recursive: true });
      syncDirectoryContents(stagingDir, absOut);
      result.out_dir = absOut;
    }

    if (opts.push) {
      const remoteUrl = resolveRemoteUrl(root, opts.remote);
      const pushRes = publishToRemote(stagingDir, {
        root,
        remoteUrl,
        branch: opts.branch,
        message: opts.message,
        secretRules,
        forbiddenPatterns,
      });
      result.remote_url = remoteUrl;
      result.branch = opts.branch;
      Object.assign(result, pushRes);
    }

    if (opts.dryRun) {
      result.files = exportedFiles.map((f) => f.path);
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await runSyncTemplate(process.argv.slice(2));
}
