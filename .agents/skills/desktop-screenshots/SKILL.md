---
name: desktop-screenshots
description: Refresh Copilot API Desktop documentation screenshots from an already running local Desktop instance. Use when updating the Desktop captures in docs/screenshots or adding a capture of a specific tab such as API Keys.
---

# Desktop Screenshots

Use the running Desktop app, its live gateway data, and its saved settings. Inspect the existing PNGs and their documentation references to identify the requested views and match their framing. The current desktop set uses a 1366 × 720 viewport.

## Capture

1. Identify the running Copilot API Desktop window and use the session's supported window capture controls. On macOS, use native window capture when the system title controls should appear. On Windows, use Computer Use when its JavaScript runtime is available.
2. Open each requested view and wait for its data to load. Capture the application window. Use the same period on Dashboard and Token usage when comparing their totals. Keep the current language and theme unless the user requests a different presentation.
3. Capture API Keys with the actual key entries, statuses, quotas, and expiry dates. Mask the entire secret, including any visible prefix and suffix, in the final PNG. Apply the same check to the Dashboard auth header. Keep credentials and private identifying details out of the saved images.
4. When direct window capture is unavailable, use the installed Desktop renderer with data from the running gateway. Follow [Capturing from the live gateway](references/live-gateway.md) for the data sources and isolated renderer setup. If a requested state cannot be recovered, report the specific limitation. Capture the real empty state whenever the current app has no entries.

For a full refresh, use these paths relative to `docs/screenshots/`. Keep the existing names of supported views so documentation links continue to work.

| View | Screenshot |
| --- | --- |
| Dashboard | `desktop-dashboard.png` |
| Token usage | `desktop-token-usage.png` |
| Providers | `provider-management.png` |
| API Keys | `desktop-api-keys.png` |
| Client integrations | `desktop-client-integrations.png` |
| Create | `desktop-create.png` |
| Advanced configuration | `desktop-config-editor.png` |
| Advanced configuration conflict | `desktop-config-editor-conflict.png` |
| Settings, Startup, Server runtime | `desktop-server-runtime.png` |

Capture the conflict banner from an existing conflict or reproduce it in an isolated preview with a disposable draft based on the current config. Identify the previewed conflict in the handoff. For Create, use the current page state or the default form when the live draft is unavailable.

## Verify

- Open every changed PNG and check the selected view, crop, readability, and credential masking.
- Compare the visible model count, usage totals, and key quotas with the running gateway for the same period wherever those values appear.
- Check the changed paths and existing Markdown image references. Run `git diff --check` and follow the repository's guidance for screenshot-only changes.
- Report the capture method and any view that required an isolated preview. Commit or push when the user requests it.
