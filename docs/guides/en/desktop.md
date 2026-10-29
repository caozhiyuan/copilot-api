# Desktop App

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/desktop.md)

## Image and video creation

Start the local service and open **Create** to generate images from prompts, edit uploaded images, or generate videos. Images support the default gateway route, Codex, or xAI, with editable model, size, quality, and output count (1–4). The default route uses `imageGenerationModel`, `imageEditModel`, and model mappings; explicit Codex or xAI selections use the corresponding enabled provider directly. Image edits accept up to 5 PNG, JPEG, or WebP files, at most 20 MiB each and 40 MiB total.

Video creation uses `xai/grok-imagine-video-1.5` and requires an enabled xAI provider. Use a prompt, one first-frame image, or both; choose 1–15 seconds, 480p/720p/1080p, and audio. The page checks progress every 5 seconds and offers pause, resume, and stop tracking. Switching tabs preserves drafts, results, and tasks; closing or reloading the app clears this temporary state. **Stop waiting** and **Stop tracking** only stop local waiting or polling; they do not cancel an upstream generation task.

Preview results in the page and save them through the system file dialog. Video URLs are temporary, so save finished videos promptly.

## Electron Desktop App

Open **Subscriptions** to view GitHub Copilot, Codex, xAI, and OpenCode Go allowances in one place. Provider cards include bundled models.dev logos, plan names, remaining allowances, usage windows, reset times, and available balances. Refresh providers individually or use **Refresh all**. Copilot includes Premium, Chat, and Completions; Codex includes personal/model windows and Business workspace credits/member limits; xAI includes Grok Build weekly/monthly allowances, legacy monthly budgets, pay-as-you-go usage, and prepaid balances. OpenCode Go includes rolling 5-hour, weekly, and monthly usage percentages and reset times, using the configured API key. Data comes from the CLI server and loads on the first visit; switching away and back keeps the existing results until you refresh them. The web viewer has the same Subscriptions tab; Token Usage is reserved for request history and performance.

If you prefer a GUI, this repository also includes an Electron desktop app in `desktop/`. It supports GitHub Copilot sign-in, OpenAI Codex OAuth with manual switching among up to 3 Codex accounts and removal of accounts that are not in use, and API-key configuration for Kimi, DeepSeek, DashScope, OpenRouter, or a custom provider. At the top of the Dashboard, a usage snapshot summarizes the selected period with requests, total tokens, cache hit rate, estimated cost, and the busiest model. Provider configuration, server API keys, and account changes automatically refresh the running service; new requests use the updated configuration. After authorization or provider configuration, it can start and stop the local proxy with one click and shows the local endpoint, auth header, available models, usage, and logs in the app.

Server runtime, listening host, proxy, verbose logging, and token logging are server startup options. Saving changes automatically restarts a running service and may interrupt active requests. OAuth App, API Home, SQLite DB Path, and Enterprise URL still require restarting the desktop app. Saving while the service is stopped does not start it.

On new installations, **Settings → Startup → Server runtime** defaults to **Bun (recommended)**. Existing configurations without a runtime selection keep the bundled Node.js runtime on upgrade to preserve system proxy and PAC behavior; you can switch them to Bun in Settings. The app checks local `PATH`, `BUN_INSTALL`, the user Bun installation directory, and common desktop installation locations. Only stable Bun >= 1.4.0 is used; missing, older, or unusable installations fall back to the bundled Electron Node.js runtime. The settings screen shows detection status, and server logs show the selected runtime. Choose **Node.js (bundled)** to always use Electron's Node.js without installing a separate Node.js runtime.

Bun installed with `npm install -g bun` under nvm is also supported on Windows, macOS, and Linux. Detection checks the active `NVM_BIN` or `NVM_SYMLINK`, the configured npm global prefix, and installed Node versions under `NVM_DIR`/`NVM_HOME` or common default nvm directories (including XDG locations). Without an active version in the desktop environment, Node version directories are searched newest first for a supported Bun. On Windows, the app runs the npm package's native `bun.exe` directly.

Bun runs the JavaScript shipped with the app directly (`bun --no-orphans --no-install <resources>/server/main.js start ...`); it does not run `bunx`, install an npm package, or launch the TypeScript source. The desktop bundle includes its dependencies, and the app manages the child's logs, readiness, restart, and termination. Install or upgrade Bun separately, then start or restart the server to detect it again.

With Bun, **Network → Custom proxy** passes HTTP/HTTPS proxy and bypass settings to the child process. Bun does not use Electron's system proxy or PAC configuration; configure a custom proxy when needed, or select Node.js to retain Electron's system networking. The desktop UI and updates continue using Electron's selected proxy mode.

Retrying GitHub sign-in supersedes the previous attempt, including token finalization. A superseded attempt cannot report success or overwrite a newer completed sign-in.

The settings screen also exposes `OAuth App`, `API Home`, `SQLite DB Path`, `Enterprise URL`, verbose logging, and minimize-to-tray. Windows x64 (`.exe`), macOS Apple Silicon (`.dmg`), and Linux x64 (`.AppImage`) packages are published in GitHub Releases:

https://github.com/caozhiyuan/copilot-api/releases

On Linux, make the downloaded AppImage executable before launching it:

```sh
chmod +x Copilot-API-*-linux-x86_64.AppImage
./Copilot-API-*-linux-x86_64.AppImage
```

Download the installer for your platform, authorize or configure a provider inside the app, choose a port, start the server, then point your client at the local endpoint shown in the app. Installing Bun >= 1.4.0 is recommended; the bundled Node.js fallback keeps the app usable without it. Token usage history uses SQLite from the selected runtime.

Packaged builds check the latest stable GitHub Release 15 seconds after launch and every 6 hours. You can also use **Settings → Updates → Check for updates**. Windows NSIS and Linux AppImage builds download updates automatically and verify the installer against the SHA-512 checksum in the release metadata. Click **Restart and install** when ready; installation stops the local API server and interrupts active requests. Closing the app does not install a pending update.

macOS downloads a complete, SHA-512-verified DMG to your system Downloads folder. After the first full download, later updates can reuse the cached DMG and download only changed blocks. Missing or damaged caches and failed differential requests fall back to a full download. A cached installer can be reused even if you have not installed that version yet.

When the installed macOS application and its parent directory support replacement, **Restart and install** prepares the new application, stops the server, and uses a separate helper to replace and restart it. The helper keeps the previous app until the new app acknowledges startup and attempts to restore it if startup fails. User configuration and databases are not replaced. **Show in folder** and **Open installer** remain available for manual installation. Apps running from a DMG, App Translocation, or a non-writable location use manual installation. A failed automatic preparation also retains the downloaded DMG for manual use.

These builds do not have Developer ID signing or notarization. The custom macOS installer does not use Squirrel.Mac and does not disable system security checks; macOS may still require you to allow a new version to open. Linux builds launched outside an AppImage and older releases without updater metadata use the release-page download link. Development builds do not check for updates. Update requests use the app's configured proxy.

The desktop release workflow uploads `latest.yml`, Windows `.blockmap` files, `latest-linux.yml`, macOS `.dmg.blockmap` files, and `latest-mac.yml` alongside installers. Installers are uploaded before update metadata. Releases without these files require manual installation first; the first macOS download may also be full because no DMG baseline exists yet.

The desktop app's **Advanced config** page edits `config.json` through grouped fields and a shared full-JSON draft, including model mappings. It uses Electron IPC to read and write the file, so editing also works while the service is stopped. A running service is refreshed through `/admin/config/reload` using `auth.adminApiKey`. See [Desktop configuration editor](configuration.md#desktop-configuration-editor) for validation, conflict detection, masking and apply/retry behavior.
