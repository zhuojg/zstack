# Policy: Memory & Audit Governance

## Separation of Raw Receipts vs Curated Memory

- **Task Runtime & Raw Receipts (`tasks/active/<id>/`)**: High-volume, time-bound execution state (`state.json`), append-only audit log (`events.jsonl`), and raw structured worker outputs (`receipts/*.json`). Archived to `tasks/archive/YYYY-MM/` on closure; never bulk-loaded into future tasks.
- **Curated Reusable Memory (`memory/`)**: Low-noise, cross-task knowledge split into:
  - `memory/preferences.md`: User workflow preferences.
  - `memory/facts/global.md`: Cross-project engineering & T3 facts.
  - `memory/facts/<slug>.md`: Per-project durable facts & pitfalls.
  - `memory/INDEX.md`: Script-generated compact index (`./scripts/zstack reindex`).

## Required Metadata per Memory Entry

Every entry in `memory/preferences.md` and `memory/facts/*.md` must include:
- `id` (unique stable ID, e.g. `mem-example-0001`)
- `scope` (`global` | `project:<slug>`)
- `kind` (`preference` | `fact` | `pitfall` | `decision`)
- `confidence` (`verified` | `observed` | `inferred`)
- `source` (file ref, PR URL, task ID, or user date)
- `created_at` & `verified_at` (`YYYY-MM-DD`)
- `ttl_days` (default: `90` for technical facts, `180` for preferences)
- `status` (`active` | `stale` | `superseded` | `retracted`)
- `superseded_by` (`null` or replacement `id`)

## Promotion, Decay & Retraction

- During active execution, write only to `tasks/active/<id>/`.
- On task closure, promote verified cross-task facts automatically (with `./scripts/zstack check-secrets` passing) and report promoted IDs in the closure summary.
- Updating `policies/` or changing global preferences requires explicit user confirmation.
- Never silently delete outdated entries: mark `status: superseded` (with `superseded_by`) or `status: retracted` with a brief reason.
- Entries past `verified_at + ttl_days` are flagged `stale` by `./scripts/zstack reindex` and must be re-verified before acting as constraints.

## Hard Privacy & Secret Redlines (Even in Private Repo)

- **NEVER commit to Git**: API keys, tokens, passwords, SSH private keys, cookies, kubeconfigs, DB/cache credential URLs, presigned S3/OSS URLs, webhook secret URLs, real customer PII, or raw production logs/DB dumps.
- **Sensitive File Diff Discipline**: When inspecting or diffing files that may contain secrets (`.env`, Helm `values*.yaml`, Kubernetes Secrets, kubeconfigs, webhook configs, key files), use **only** `--stat`, `--name-only`, or `key name + sha256` comparisons. **Never** print plaintext diff lines or raw secret values into stdout, logs, receipts, or reports.
- Secrets flow only through T3 `request_secret`, system Keychain, or runtime env vars.
- Raw production logs (if temporarily saved during troubleshooting) go only to `~/.zstack-local/ephemeral/<task-id>/` (outside Git, auto-cleaned). Only sanitized diagnostic IDs and root-cause conclusions enter `zstack`.

## Storage Scaling Thresholds

- **Stage 1 (<50 tasks, <200 memories, <=3 concurrent)**: Pure Git files + `rg` + `memory/INDEX.md`.
- **Stage 2 (50–500 tasks or >200 memories)**: Add `.zstack-cache/index.sqlite` (`.gitignore`d, fully rebuildable from Git).
- **Stage 3 (>500 tasks or >8 concurrent writers)**: Move active runtime task locks to SQLite WAL or Beads/Dolt while keeping Git as policy/archive SoT.
