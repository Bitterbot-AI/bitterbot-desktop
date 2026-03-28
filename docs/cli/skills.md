---
summary: "CLI reference for `bitterbot skills` (list/info/check) and skill eligibility"
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
---

# `bitterbot skills`

Inspect skills (bundled + workspace + managed overrides) and see what’s eligible vs missing requirements.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- Skills: [Skills](/tools/skills)

## Commands

```bash
bitterbot skills list
bitterbot skills list --eligible
bitterbot skills info <name>
bitterbot skills check
```
