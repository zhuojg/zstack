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
./scripts/zstack init-task example-demo example "Task title"
./scripts/zstack next-request-id example-demo review-r1 sha-2194243d
./scripts/zstack check-receipt example-demo tasks/active/.../receipts/review.json --pinned-sha 2194243d --role reviewer
./scripts/zstack merge-gate example-demo
./scripts/zstack reindex
./scripts/zstack check-secrets
./scripts/zstack push-private --dry-run
./scripts/zstack sync-template --dry-run
```

Use `./scripts/zstack push-private [--remote <name>] [--branch <name>] [--dry-run]`
to synchronize a configured private remote. It defaults to `origin/main`,
requires a clean worktree on the target branch, and runs the full
`check-secrets` scan before a fast-forward push. Configure the public remote
as `template` so the command can reject aliases of its URL. The JSON result
includes the local commit, remote branch readback, and scanner results.
Use `./scripts/zstack sync-template --push` for the sanitized public export.

## Board v2 and background service

Board v2 shows live task, backlog, release, and archive views. Run
`./scripts/zstack serve` and open `http://127.0.0.1:4390` for an interactive
session. Run `./scripts/zstack board` to regenerate the Markdown board.

On macOS, `./scripts/zstack daemon install` registers a per-user LaunchAgent
that keeps the loopback dashboard and its GitHub watcher running together.
Use `./scripts/zstack daemon status`, `./scripts/zstack daemon restart`, and
`./scripts/zstack daemon logs` to manage it. Run either the foreground server
or the LaunchAgent on the default port.

The watcher in `scripts/github-poller.mjs` uses the authenticated GitHub CLI
to check configured repositories and tracked pull requests. It reuses ETags
to skip unchanged responses. The board shows watcher status and lets you
pause polling, change the interval, or sync immediately.

Run `node --test tests/*.test.mjs` to test the watcher and private push CLI
using a mock GitHub CLI, a local webhook receiver, and temporary Git repositories.
The LaunchAgent validation runs on macOS.
