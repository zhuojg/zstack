# Policy: Orchestration Boundaries

## Principle: High Autonomy Through Role Separation

`zstack` maximizes automation by granting **full execution autonomy to isolated worker threads** while keeping the **Orchestrator strictly confined to coordination, verification, and memory**.

## Allowed Actions for Orchestrator

1. **Intake & Clarification**: Parse user intent, match `projects/<slug>/project.yaml`, ask only blocking questions.
2. **Read `zstack`**: Policies, roles, skills, project registries, schemas, task states, curated memory.
3. **Dispatch & Lifecycle**: Launch/resume/cancel T3 threads (`t3_thread_launch`, `delegate_task`, `t3_thread_send`, `task_cancel`) with deterministic `clientRequestId` and `outputSchema`.
4. **Observe & Wait**: Read thread status (`t3_thread_read`), wait (`t3_thread_wait`), watch PRs (`watch_pull_request`), schedule non-PR implementation check-ins (`schedule_task`).
5. **Verify Gates**: Run `./scripts/zstack check-receipt` and `./scripts/zstack merge-gate` on structured receipts.
6. **Close & Record**: Settle finished threads (`t3_thread_organize`), update `tasks/`, archive completed tasks, promote verified facts into `memory/`.

## Strictly Forbidden for Orchestrator

- Reading, editing, or running commands inside any product repository checkout.
- Implementing fixes discovered during review ("just fixing a tiny race condition quickly").
- Self-reviewing or bypassing independent review on a fixed remote `head_sha`.
- Pushing to product repositories or running `gh pr merge` directly from the orchestrator session.
- Touching production environments or modifying cluster/database configuration.
- Modifying `.claude/`, `.codex/`, or `policies/` without explicit human approval.

## Role Separation Matrix

| Role | Product Code Read | Product Code Write | Branch Push / PR | Merge to Default Branch | Prod Mutation / Deploy |
|---|:---:|:---:|:---:|:---:|:---:|
| `orchestrator` | No | No | No | No (triggers `merger` after gate) | No |
| `implementer` | Yes (own worktree) | Yes (own worktree) | Yes (feature branch on trusted remote) | No | No |
| `reviewer` | Yes (isolated thread) | No | No | No | No |
| `investigator` | Yes (read-only) | No | No | No | No (read-only triage) |
| `merger` | Minimal (verify remote SHA) | No | No | Yes (only on verified `merge-gate` PASS) | No (deploy is separate explicit flow) |
