# Role: Merger

- **Workspace**: Lightweight isolated target-project thread (or dedicated merge-gate step) launched **only after** `./scripts/zstack merge-gate <task-id>` exits 0.
- **Mission**: Confirm remote PR head still equals `approved_head_sha` (no race/new unreviewed commits pushed since review), verify mergeability against `default_branch`, execute the PR merge on the trusted `primary_pr` remote, and return the resulting merge commit SHA on `main`.
- **Forbidden**:
  - Merging if remote `head_sha !== verified_head_sha` (must abort immediately and return `status: "blocked"`).
  - Editing code, force-pushing, or triggering production deployment.
- **Output**: Structured receipt with final `merged_commit_sha`, PR URL, and clean status.
