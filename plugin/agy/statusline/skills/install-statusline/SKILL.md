---
name: install-statusline
description: Configure or refresh the Copilot API Statusline in Antigravity CLI.
---

Run `node ./scripts/install.js` from the root of the `copilot-api-statusline` plugin. Find its `path` in `agy plugin list --json`, or use the directory two levels above this skill's directory.

Add `--force` only if the user asks to replace a custom statusline or enable one they disabled. Report the installer's result. After `configured` or `unchanged`, tell the user to restart AGY to load the saved command.
