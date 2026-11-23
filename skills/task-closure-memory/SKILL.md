---
name: task-closure-memory
description: Close a merged or completed task, settle T3 threads, archive task state, and promote verified reusable facts to curated memory with secret scanning.
---

# SOP: Task Closure & Memory Promotion

## Steps

1. **Unwatch & Settle T3 Resources**
   - Call `unwatch_pull_request` on any watched PR for this task.
   - Call `t3_thread_organize(action: "settle")` on finished worker threads owned by this task.
2. **Finalize Task State**
   - Append `task_closed` event (include final `merged_commit_sha`, PR URL, and explicit residual `open_risks` such as "not deployed to prod").
   - Move `tasks/active/<task-id>` to `tasks/archive/YYYY-MM/<task-id>`.
3. **Curate Reusable Memory (Promotion Gate)**
   - Review receipts for **durable cross-task facts or pitfalls** only (do NOT dump raw test logs or one-off PR details into `memory/`).
   - For each promoted item, append to `memory/facts/<slug>.md` (or `global.md`) with full metadata (`id`, `scope`, `kind`, `confidence`, `source`, `created_at`, `verified_at`, `ttl_days`, `status: active`).
   - If an older memory entry is invalidated, set its `status: superseded` and `superseded_by: <new-id>` instead of deleting it.
   - Run `./scripts/zstack reindex` to refresh `memory/INDEX.md`.
4. **Secret Scan & Commit**
   - Run `./scripts/zstack check-secrets` across changed files. Abort if any finding triggers.
   - Commit the archived task and memory update in `zstack` Git, then send a concise Chinese summary to the user with PR/thread links, final SHA, promoted memory IDs, and open risks.
