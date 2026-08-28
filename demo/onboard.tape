# Bitterbot demo tape — onboard → first chat → agent reply.
#
# Rendered with charmbracelet/vhs:
#   vhs demo/onboard.tape        # writes demo/onboard.gif
#
# The tape is checked in ON PURPOSE: anyone can regenerate the demo from
# source, which makes the gif a reproducible claim instead of a marketing
# asset. Keep it deterministic: no timestamps in prompts, no network luck —
# it drives the same QuickStart path CI exercises.
#
# Prereqs on the recording machine: a fresh checkout, `pnpm install` done,
# an ANTHROPIC_API_KEY in the environment, and no ~/.bitterbot config
# (the wizard must take its fresh-install path).

Output demo/onboard.gif

Set FontSize 12
Set Width 1200
Set Height 720
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

# ── Onboard: QuickStart is five prompts ──
Type "pnpm bitterbot onboard"
Enter
Sleep 8s

# Risk acknowledgement
Type "y"
Enter
Sleep 2s

# Flow: QuickStart (default selection)
Enter
Sleep 2s

# Provider: Anthropic API key (default; key picked up from env)
Enter
Sleep 3s

# P2P consent
Type "y"
Enter
Sleep 20s

# Wizard finishes; gateway is up and serving the Control UI.
Sleep 5s

# ── First agent message from the CLI ──
Type "pnpm bitterbot agent --to demo --message 'Introduce yourself in one sentence.'"
Enter
Sleep 25s

Sleep 3s
