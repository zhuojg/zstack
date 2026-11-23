---
name: pr-sha-review
description: Pin an exact remote PR head SHA and dispatch an independent Reviewer thread (separate from Implementer) with structured receipt validation.
---

# SOP: Fixed-SHA Independent PR Review

## Preconditions

- PR URL exists and remote exact `head_sha` and `base_sha` have been confirmed.
- PR is linked to the orchestrator thread (`link_pull_request`) and watched (`watch_pull_request`, `until: "checks"` or `"merged"`).

## Steps

1. **Deduplicate by SHA**
   - Run `./scripts/zstack next-request-id <task-id> review-r<round> sha-<short-sha>`.
   - Never launch two full reviews for the exact same `head_sha`.
2. **Launch Independent Reviewer**
   - Always start a **new** cross-project thread via `t3_thread_launch` (`projectId` from `project.yaml`, `workspaceStrategy: { type: "worktree", baseRef: "<default_branch>", startFromOrigin: true }`), NEVER `t3_thread_send` to the Implementer thread and NEVER local `delegate_task` with another `projectId`.
   - Prefer a different provider/model per `project.yaml` `capabilities.review` when available.
   - Inject `roles/reviewer.md` boundaries: exact `pinned_head_sha`, read-only on product code (`working_tree_clean: true`), no pushing or merging.
   - Pass `schemas/worker-receipt.schema.json` as `outputSchema`.
3. **Validate Receipt Deterministically**
   - Save returned JSON to `tasks/active/<task-id>/receipts/review-r<round>-<short-sha>.json`.
   - Run `./scripts/zstack check-receipt <task-id> <receipt-path> --pinned-sha <head_sha> --role reviewer`.
4. **Route Next Action**
   - If `status == "changes_requested"`: update `state.json` open findings and dispatch fixes back to `threads.implementer.thread_id` via `t3_thread_send`.
   - If `status == "pass"`: update `gates.independent_review_pass` and run `./scripts/zstack merge-gate <task-id>`. If gate passes and policy is `auto_merge_on_gate_pass`, dispatch `Merger` step (`roles/merger.md`).
