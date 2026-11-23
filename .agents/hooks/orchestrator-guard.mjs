#!/usr/bin/env node
/**
 * Antigravity (gemini-4-neon) PreToolUse hook for zstack Orchestrator.
 * Contract: reads camelCase JSON from stdin, writes { decision: "allow" | "deny", reason? } to stdout, exits 0.
 */

import fs from "node:fs";
import { checkReadPath, checkShellCommand, checkWritePath } from "../../scripts/guard-policy.mjs";

function allow() {
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
  process.exit(0);
}

function deny(reason) {
  process.stdout.write(JSON.stringify({ decision: "deny", reason: `[zstack-guard] ${reason}` }) + "\n");
  process.exit(0);
}

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
]);

const READ_TOOLS = new Set([
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
  "find_by_name",
  "grep_search",
]);

const SHELL_TOOLS = new Set(["run_command"]);

function main() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) allow();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    deny("Malformed PreToolUse hook payload; failing closed.");
  }

  const toolName = String(payload?.toolCall?.name || "").toLowerCase();
  const args = payload?.toolCall?.args || {};

  if (WRITE_TOOLS.has(toolName)) {
    const targetPath = args.Path || args.path || args.TargetFile || args.file_path;
    const res = checkWritePath(targetPath, toolName);
    return res.allowed ? allow() : deny(res.reason);
  }

  if (READ_TOOLS.has(toolName)) {
    const targetPath =
      args.Path ||
      args.path ||
      args.AbsolutePath ||
      args.DirectoryPath ||
      args.SearchDirectory ||
      args.SearchPath ||
      args.file_path;
    const res = checkReadPath(targetPath, toolName);
    return res.allowed ? allow() : deny(res.reason);
  }

  if (SHELL_TOOLS.has(toolName)) {
    const cmd = args.CommandLine || args.command || "";
    const res = checkShellCommand(cmd);
    return res.allowed ? allow() : deny(res.reason);
  }

  allow();
}

main();
