/**
 * Shared deterministic guardrail policy for zstack Orchestrator.
 * Consumed by both Antigravity (.agents/hooks/orchestrator-guard.mjs)
 * and Claude Code (.claude/hooks/orchestrator-guard.mjs).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ZSTACK_ROOT = path.resolve(__dirname, "..");

function loadEnvProductPrefixes() {
  const raw = process.env.ZSTACK_FORBIDDEN_PRODUCT_PREFIXES || "";
  return raw
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("~/") ? path.resolve(process.env.HOME || "", p.slice(2)) : path.resolve(p)));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

const PROTECTED_ZSTACK_SUBPATHS = [
  path.join(ZSTACK_ROOT, ".git"),
  path.join(ZSTACK_ROOT, ".agents"),
  path.join(ZSTACK_ROOT, ".claude"),
  path.join(ZSTACK_ROOT, ".codex"),
  path.join(ZSTACK_ROOT, "scripts", "guard-policy.mjs"),
];

export function loadRegisteredProductPaths() {
  const prefixes = new Set(loadEnvProductPrefixes());
  const projectsDir = path.join(ZSTACK_ROOT, "projects");
  if (!fs.existsSync(projectsDir)) return [...prefixes];

  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const yamlPath = path.join(projectsDir, entry.name, "project.yaml");
    if (!fs.existsSync(yamlPath)) continue;
    const text = fs.readFileSync(yamlPath, "utf8");
    const match = text.match(/workspace_root_ref:\s*["']?([^"'\n#]+)["']?/);
    if (match && match[1]) {
      prefixes.add(path.resolve(match[1].trim()));
    }
  }
  return [...prefixes];
}

export function isInside(targetPath, basePath) {
  const rel = path.relative(basePath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveMaybeRelative(p) {
  if (!p || typeof p !== "string") return null;
  if (p.startsWith("~/")) {
    return path.resolve(process.env.HOME || "", p.slice(2));
  }
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(ZSTACK_ROOT, p);
}

const FORBIDDEN_CMD_PATTERNS = [
  { re: /(?:^|[;&|()]\s*|\s)(?:pnpm|npm|npx|yarn|bun|cargo|rustc|pytest|vitest|jest|tsc|tsrs)\b/, label: "product build/test toolchain" },
  { re: /(?:^|[;&|()]\s*|\s)(?:kubectl|helm|terraform|docker|docker-compose|ssh|scp|psql|mysql|redis-cli)\b/, label: "infrastructure/prod CLI" },
  { re: /\bgh\s+pr\s+merge\b/, label: "direct PR merge via gh" },
  { re: /\bgit\s+push\b/, label: "direct git push" },
  { re: new RegExp("\\bgit\\s+-C\\s+(?!\\.\\/|['\\\"]?" + escapeRegExp(ZSTACK_ROOT) + ")"), label: "git -C targeting external repository" },
  { re: /(?:^|[;&|()]\s*|\s)(?:bash|sh|zsh|python3?|node)\s+-(?:c|e)\b/, label: "inline shell/script execution (potential guardrail bypass)" },
];

export function checkWritePath(rawPath, toolName) {
  const resolved = resolveMaybeRelative(rawPath);
  if (!resolved) {
    return { allowed: false, reason: `Missing target path for ${toolName}.` };
  }
  if (!isInside(resolved, ZSTACK_ROOT)) {
    return {
      allowed: false,
      reason: `${toolName} target "${resolved}" is outside zstack (${ZSTACK_ROOT}). Orchestrator cannot modify external files.`,
    };
  }
  for (const protectedPath of PROTECTED_ZSTACK_SUBPATHS) {
    if (isInside(resolved, protectedPath)) {
      return {
        allowed: false,
        reason: `${toolName} target "${resolved}" is inside protected guardrail path "${protectedPath}".`,
      };
    }
  }
  return { allowed: true };
}

export function checkReadPath(rawPath, toolName) {
  const resolved = resolveMaybeRelative(rawPath);
  if (!resolved) return { allowed: true };
  const productPaths = loadRegisteredProductPaths();
  for (const prodPath of productPaths) {
    if (isInside(resolved, prodPath)) {
      return {
        allowed: false,
        reason: `${toolName} target "${resolved}" is inside product repository "${prodPath}". Dispatch an investigator/reviewer thread instead.`,
      };
    }
  }
  return { allowed: true };
}

export function checkShellCommand(command) {
  if (!command || typeof command !== "string") return { allowed: true };
  const productPaths = loadRegisteredProductPaths();
  const home = process.env.HOME || "";

  for (const prodPath of productPaths) {
    if (command.includes(prodPath)) {
      return {
        allowed: false,
        reason: `Shell command references product repository path "${prodPath}". Dispatch a worker thread instead.`,
      };
    }
    if (home && prodPath.startsWith(home)) {
      const tildePath = "~" + prodPath.slice(home.length);
      if (command.includes(tildePath)) {
        return {
          allowed: false,
          reason: `Shell command references product repository path "${tildePath}". Dispatch a worker thread instead.`,
        };
      }
    }
  }

  for (const { re, label } of FORBIDDEN_CMD_PATTERNS) {
    if (re.test(command)) {
      return {
        allowed: false,
        reason: `Shell command blocked (${label}). Orchestrator must not execute product/infra/merge commands directly.`,
      };
    }
  }
  return { allowed: true };
}
