# Policy: Evidence & Auto-Merge Gates

## High-Autonomy Delivery Mode

Default delivery mode is **`auto_merge_on_gate_pass`**: once a PR passes deterministic verification and independent review on the exact remote `head_sha`, the pipeline proceeds automatically to merge and closure without interrupting the user.

## Mandatory Evidence Standards

1. **Exact SHA Pinning**: Every review receipt must record the exact remote `base_sha` and `head_sha` inspected. Stale SHA receipts are rejected automatically.
2. **Skipped Is Not Passed**: Test receipts must report `passed`, `failed`, and `skipped` counts separately. A green exit code with mandatory suites skipped does not satisfy a gate.
3. **Author != Reviewer**: Implementer self-checks are prerequisites for opening review, never a substitute for an independent Reviewer thread.
4. **Reviewer != Fixer**: Reviewers report structured `findings` (`blocker` / `major` / `minor` with `location` and `repro_or_evidence`) and never mutate product code.
5. **Bounded Incremental Re-verification**: After Implementer pushes fixes, Round N+1 Reviewer verifies only unresolved findings + regression surface of the new diff (`old_sha..new_sha`). Max 3 review rounds before escalating to human.

## Auto-Merge Gate (`./scripts/zstack merge-gate <task-id>`)

All conditions must hold simultaneously:
1. `project.yaml` allows `auto_merge_on_gate_pass` (or human explicitly approved `approved_head_sha`).
2. Latest `independent_review_pass.verified_head_sha === pull_request.head_sha`.
3. `reviewer_thread_id !== implementer.thread_id`.
4. Zero `open` findings with severity `blocker` or `major`.
5. All required checks in receipt have `result === "pass"` and `failed === 0`.
6. Changed files stay within task scope; target remote is in `trusted_remotes` with `role: "primary_pr"`.

## Three Irreversible Redlines (Always Pause for Human Approval)

1. **Production write / deploy / permission mutation** (default forbidden unless explicitly authorized for a specific change).
2. **Destructive Git or untrusted remote operations** (force-push default branch, pushing to mirror remotes like `gitlab`).
3. **Non-convergence after 3 review rounds**.
