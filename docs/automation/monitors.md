---
summary: "Watch a page or an API and wake the agent only when it changes"
read_when:
  - You want to be told when a price, a stock status or a status page changes
  - Choosing between a monitor and a recurring cron job
title: "Monitors"
---

# Monitors

A monitor watches one value on a web page or an API and wakes the agent only when that value changes or crosses a line you set. Checking is a plain fetch on the gateway and a comparison. No model is called until there is something to report, so a monitor that checks every few minutes for a month costs nothing while nothing happens.

Use a monitor when the question is "tell me when X changes". Use a [cron job](/automation/cron-jobs) when the work has to happen at a time whatever the world is doing ("every Friday, summarize my open tasks").

## Setting one up

Ask the agent in plain words:

> Watch this product page and tell me when it is back in stock.
>
> Let me know if the price on this page drops below 80.

The agent uses its `monitor` tool. You can also call the gateway directly:

```bash
bitterbot gateway call monitors.add --params '{
  "name": "Widget stock",
  "url": "https://shop.example.com/widget",
  "condition": { "kind": "contains", "text": "In stock" },
  "intervalMinutes": 10,
  "note": "Message me the link"
}'
```

## What is watched

`extract` picks the value out of the response:

| `extract`                                           | The value is                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `{ "kind": "text" }` (default)                      | the page's visible text: markup, scripts and extra spacing removed |
| `{ "kind": "json", "path": "data.price" }`          | one field of a JSON body; `items[0].status` style paths work       |
| `{ "kind": "regex", "pattern": "...", "group": 1 }` | the first match of a pattern in the raw body, or one capture       |

Narrow it. A whole page changes for reasons you do not care about (a timestamp, an advert), and a monitor on the whole page fires for all of them.

## When it fires

| `condition`                                      | Fires when                                        |
| ------------------------------------------------ | ------------------------------------------------- |
| `{ "kind": "changed" }` (default)                | the value differs from the last check             |
| `{ "kind": "contains", "text": "In stock" }`     | the value starts to contain the text              |
| `{ "kind": "not-contains", "text": "Sold out" }` | the value stops containing the text               |
| `{ "kind": "above", "value": 100 }`              | the number in the value rises above the threshold |
| `{ "kind": "below", "value": 100 }`              | the number in the value falls below the threshold |

`changed` never fires on the first check, because there is nothing to compare with. The others fire when they start to hold, including on the first check, and not again until they have stopped holding and started again.

When a monitor fires you get a notice (main session, Control UI, and your chat channel subject to [`notifications`](/gateway/configuration-reference#notifications)) and the agent is woken with your `note`, so it can act on it.

## Health

Each monitor records when it was last checked, when its value last changed, when it last fired and its last error. A monitor that cannot be checked three times in a row tells you once, then keeps trying less often (up to eight times its interval) until it works again.

```bash
bitterbot gateway call monitors.list
bitterbot gateway call monitors.check --params '{"id":"mon_..."}'
```

The **Automations** page in the Control UI lists every monitor with its current value and health, and has Check now, Pause and Remove. The same page shows scheduled jobs and the agent's longer tasks.

## Limits

- Public `http` and `https` addresses only. Requests go through the same guard as `web_fetch`: private and loopback addresses are refused.
- The page is fetched, not rendered. Content that only appears after JavaScript runs is not seen; point the monitor at the API the page calls instead.
- The shortest interval is one minute (a shorter one is raised to it); the default is 15. Up to 50 monitors.
- Responses that declare more than 2 MB are refused; longer bodies without that header are cut to 2 MB.
- Only the owner can add, change, remove or run monitors.
- Turn the feature off with `monitors.enabled: false`.
