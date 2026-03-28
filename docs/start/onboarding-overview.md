---
summary: "Overview of Bitterbot onboarding options and flows"
read_when:
  - Choosing an onboarding path
  - Setting up a new environment
title: "Onboarding Overview"
sidebarTitle: "Onboarding Overview"
---

# Onboarding Overview

Bitterbot supports multiple onboarding paths depending on where the Gateway runs
and how you prefer to configure providers.

## Choose your onboarding path

- **CLI wizard** for macOS, Linux, and Windows (via WSL2).

## CLI onboarding wizard

Run the wizard in a terminal:

```bash
bitterbot onboard
```

Use the CLI wizard when you want full control of the Gateway, workspace,
channels, and skills. Docs:

- [Onboarding Wizard (CLI)](/start/wizard)
- [`bitterbot onboard` command](/cli/onboard)

## Custom Provider

If you need an endpoint that is not listed, including hosted providers that
expose standard OpenAI or Anthropic APIs, choose **Custom Provider** in the
CLI wizard. You will be asked to:

- Pick OpenAI-compatible, Anthropic-compatible, or **Unknown** (auto-detect).
- Enter a base URL and API key (if required by the provider).
- Provide a model ID and optional alias.
- Choose an Endpoint ID so multiple custom endpoints can coexist.

For detailed steps, follow the CLI onboarding docs above.
