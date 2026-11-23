#!/usr/bin/env node
/**
 * Antigravity SessionStart hook: injects active zstack tasks on cold start if any exist.
 */

import fs from "node:fs";
import path from "node:path";
import { ZSTACK_ROOT } from "../../scripts/guard-policy.mjs";

function main() {
  const activeRoot = path.join(ZSTACK_ROOT, "tasks", "active");
  const active = [];
  if (fs.existsSync(activeRoot)) {
    for (const entry of fs.readdirSync(activeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statePath = path.join(activeRoot, entry.name, "state.json");
      if (!fs.existsSync(statePath)) continue;
      try {
        const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
        active.push(`${s.task_id} [${s.project_slug}] phase=${s.phase} pr=${s.pull_request?.url || "none"}`);
      } catch {
        active.push(`${entry.name} [unreadable state.json]`);
      }
    }
  }

  if (active.length === 0) {
    process.stdout.write("{}\n");
    return;
  }

  const msg =
    `[zstack cold-start] Active tasks requiring reconciliation (${active.length}):\n` +
    active.map((line) => `- ${line}`).join("\n") +
    `\nReconcile via t3_thread_read / list_thread_pull_requests before dispatching new work.`;

  process.stdout.write(
    JSON.stringify({
      injectSteps: [{ systemMessage: { systemMessage: msg } }],
    }) + "\n"
  );
}

main();
