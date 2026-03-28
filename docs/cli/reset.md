---
summary: "CLI reference for `bitterbot reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `bitterbot reset`

Reset local config/state (keeps the CLI installed).

```bash
bitterbot reset
bitterbot reset --dry-run
bitterbot reset --scope config+creds+sessions --yes --non-interactive
```
