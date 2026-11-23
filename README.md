# zstack

Personal Software Factory control plane for T3 Code.

> **Template Repository**: Generic, zero-secret control-plane template for T3 Code. Click **Use this template** to create your own private `zstack-private` repository for personal projects, tasks, and curated memory. Never commit secrets, tokens, raw production logs, or customer PII.

## Structure

- **Generic Layer (reusable / future template extractable)**:
  - `AGENTS.md` (`CLAUDE.md` symlink): minimal orchestrator entrypoint
  - `.agents/`, `.claude/`, & `.codex/`: deterministic harness guardrails across all 3 T3 providers (`antigravity` / `claudeAgent` / `codex`) sharing `scripts/guard-policy.mjs` and `.agents/skills -> ../skills`
  - `policies/`: versioned non-negotiable governance rules
  - `roles/`: role contracts (`orchestrator`, `implementer`, `reviewer`, `investigator`, `merger`)
  - `skills/`: on-demand SOPs (`agentskills.io` format)
  - `schemas/` & `scripts/zstack`: JSON schemas + thin state/gate/secret validation CLI
  - `projects/_template/`: template for onboarding new projects
- **Private Data Layer (personal operational state)**:
  - `projects/<slug>/`: per-project registry & out-of-repo SOPs
  - `memory/`: curated preferences & project facts (with source, confidence, TTL)
  - `tasks/`: active & archived task state machines (`state.json`, `events.jsonl`, `receipts/`)

## Quick CLI Reference

```bash
./scripts/zstack active
./scripts/zstack init-task tsk-20261123-example-demo example "任务标题"
./scripts/zstack next-request-id tsk-20261123-example-demo review-r1 sha-2194243d
./scripts/zstack check-receipt tsk-20261123-example-demo tasks/active/.../receipts/review.json --pinned-sha 2194243d --role reviewer
./scripts/zstack merge-gate tsk-20261123-example-demo
./scripts/zstack reindex
./scripts/zstack check-secrets
./scripts/zstack sync-template --dry-run
```
