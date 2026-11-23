# User Preferences

Durable workflow preferences. Changes here require explicit user confirmation (see `policies/memory-governance.md`).

```yaml
id: "mem-pref-0001"
scope: "global"
kind: "preference"
confidence: "verified"
summary: "Default to high-autonomy delivery with independent fixed-SHA review and deterministic merge-gate; pause only for production mutations, destructive remote git operations, or 3 non-converging review rounds."
source: "template:default"
created_at: "2026-01-01"
verified_at: "2026-01-01"
ttl_days: 180
status: "active"
superseded_by: null
```
