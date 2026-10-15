---
summary: "Use Google Gemini models in Bitterbot with a Gemini API key"
read_when:
  - You want to run Bitterbot on Gemini
  - You have a GEMINI_API_KEY and want to know where Bitterbot reads it
title: "Google Gemini"
---

# Google Gemini

Bitterbot talks to the Gemini API directly (provider `google`) with an API key
from [Google AI Studio](https://aistudio.google.com/apikey).

## Setup

The setup page (`bitterbot onboard`) offers **Google Gemini** next to
Anthropic, OpenAI and OpenRouter. Paste the key there, or export
`GEMINI_API_KEY` before you start the gateway and setup offers it by name. The
models offered are:

| Model                    | Model ref                       | Notes                      |
| ------------------------ | ------------------------------- | -------------------------- |
| Gemini 3.1 Pro (preview) | `google/gemini-3.1-pro-preview` | Most capable (recommended) |
| Gemini 3 Flash (preview) | `google/gemini-3-flash-preview` | Fastest, cheapest          |

A pasted key is saved in the auth profile store, so setup does not ask again.
With a Gemini key, setup also offers Gemini embeddings for memory search (the
local embedding model stays the recommended choice).

Scripted setup:

```bash
bitterbot onboard --non-interactive --accept-risk --auth-choice gemini-api-key --gemini-api-key "$GEMINI_API_KEY"
```

## Config snippet

```json5
{
  env: { GEMINI_API_KEY: "AIza..." },
  agents: {
    defaults: {
      model: { primary: "google/gemini-3.1-pro-preview" },
    },
  },
}
```

## Notes

- Model refs are `google/<model>`. Any model the Gemini API serves can be
  picked with `/model` or in the Control UI; the two above are the featured
  ones.
- Gemini CLI OAuth and Google Antigravity sign-ins are no longer supported;
  use an API key. For Vertex AI, use the `google-vertex` provider (gcloud ADC).
  See [Model providers](/concepts/model-providers#google-gemini-api-key).
