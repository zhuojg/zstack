---
name: incremental-reverify
description: After Implementer fixes review findings and pushes a new SHA, dispatch a fresh Reviewer to verify only unresolved findings and regression surface of the new diff.
---

# SOP: Bounded Incremental Re-Verification

## Steps

1. **Check Round Budget**
   - Inspect `threads.reviewers.length` in `state.json`. If already `>= 3` rounds without convergence, stop immediately, set `phase: "needs_human"`, and escalate with open findings.
2. **Confirm New Remote SHA**
   - Verify `new_head_sha !== previous_head_sha`. Record `pr_head_updated` event.
3. **Dispatch Targeted Incremental Reviewer**
   - Obtain idempotency key via `./scripts/zstack next-request-id <task-id> reverify-r<round> sha-<short-sha>`.
   - Launch a **fresh** independent Reviewer thread (`roles/reviewer.md`).
   - Restrict scope in the Brief:
     - `unresolved_items_only`: exact list of previously `open` finding IDs and summaries.
     - Diff window: `<previous_head_sha>..<new_head_sha>` regression check only (do not re-litigate already closed items unless touched by the new diff).
   - Pass `schemas/worker-receipt.schema.json` as `outputSchema`.
4. **Verify & Advance**
   - Save receipt and run `./scripts/zstack check-receipt <task-id> <receipt-path> --pinned-sha <new_head_sha> --role reviewer`.
   - If all `blocker`/`major` findings are `resolved` and `status == "pass"`, run `./scripts/zstack merge-gate <task-id>` and proceed to `Merger` or human approval per `project.yaml`.
