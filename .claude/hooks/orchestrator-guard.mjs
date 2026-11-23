#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for zstack Orchestrator.
 * Shares the exact same policy module as Antigravity (scripts/guard-policy.mjs).
 */

import fs from "node:fs";
import { checkReadPath, checkShellCommand, checkWritePath } from "../../scripts/guard-policy.mjs";

function deny(reason) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[zstack-guard] ${reason}`,
    },
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
  process.stderr.write(`[zstack-guard] BLOCKED: ${reason}\n`);
  process.exit(2);
}

function main() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) process.exit(0);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    deny("Malformed PreToolUse hook payload; failing closed.");
  }

  const toolName = event.tool_name || event.toolName || "";
  const input = event.tool_input || event.toolInput || {};

  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)) {
    const rawPath = input.file_path || input.path || input.notebook_path;
    const res = checkWritePath(rawPath, toolName);
    if (!res.allowed) deny(res.reason);
    process.exit(0);
  }

  if (["Read", "Glob", "Grep"].includes(toolName)) {
    const rawPath = input.file_path || input.path || input.pattern;
    const res = checkReadPath(rawPath, toolName);
    if (!res.allowed) deny(res.reason);
    process.exit(0);
  }

  if (toolName === "Bash") {
    const res = checkShellCommand(input.command);
    if (!res.allowed) deny(res.reason);
    process.exit(0);
  }

  process.exit(0);
}

main();
