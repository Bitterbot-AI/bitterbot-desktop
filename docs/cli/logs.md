---
summary: "CLI reference for `bitterbot logs` (tail gateway logs via RPC)"
read_when:
  - You need to tail Gateway logs remotely (without SSH)
  - You want JSON log lines for tooling
title: "logs"
---

# `bitterbot logs`

Tail Gateway file logs over RPC (works in remote mode).

Related:

- Logging overview: [Logging](/logging)

## Examples

```bash
bitterbot logs
bitterbot logs --follow
bitterbot logs --json
bitterbot logs --limit 500
bitterbot logs --local-time
bitterbot logs --follow --local-time
```

Use `--local-time` to render timestamps in your local timezone.
