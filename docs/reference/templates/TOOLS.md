---
title: "TOOLS.md Template"
summary: "Workspace template for TOOLS.md — local environment configuration"
read_when:
  - Bootstrapping a workspace manually
---

# TOOLS.md - Local Environment

Your skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup and environment.

## What Goes Here

Anything environment-specific that your skills need to know:

- API endpoints and service URLs
- Device names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Camera names and locations
- Anything that's _yours_, not generic knowledge

## Bitterbot-Specific

### Memory System

- **Dream interval:** Every 2 hours (configurable in config)
- **Curiosity engine:** GCCRF with surprise-driven exploration
- **Consolidation:** Automatic decay + importance scoring

### P2P Network

- **Orchestrator:** Runs alongside the gateway
- **Skill marketplace:** Knowledge Crystals published via gossip protocol
- **Reputation:** EigenTrust-based peer scoring

### Skills

Skills are loaded from multiple sources (highest priority last):
1. Bundled skills (shipped with Bitterbot)
2. Managed skills (`~/.bitterbot/skills`)
3. Workspace skills (`workspace/skills`)
4. P2P acquired skills (from the marketplace)

To add a custom skill, create a `.md` file or a folder with `SKILL.md` in your workspace `skills/` directory.

---

Add whatever helps you do your job. This is your cheat sheet.
