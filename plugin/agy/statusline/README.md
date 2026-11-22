# Copilot API Statusline for Antigravity CLI

[简体中文](README.zh-CN.md) | English

A standalone, local-only Antigravity CLI (`agy`) statusline plugin bundled with [copilot-api](https://github.com/caozhiyuan/copilot-api). It **does not** proxy Antigravity models, connect to the copilot-api gateway, access OAuth/CSRF tokens, or call internal ConnectRPC APIs. **No Skill or manual slash-command setup is required.**

Works on **Windows, macOS, and Linux** with Node.js 20+ (no npm dependencies).

## Install from GitHub (recommended)

Install the plugin directly from the `dev` branch:

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
agy plugin list
```

### Show the statusline on the very first launch (recommended)

`agy plugin install` installs the plugin files but does **not** run a post-install setup script. The `SessionStart` hook runs only when a conversation starts. If you launch AGY immediately after installing, the hook can configure `statusLine.command` only **after the first prompt**, when the TUI may already have loaded its statusline configuration. The new setting may not appear until AGY restarts.

To avoid having to send `hi` and restart, run the bundled setup script in your **normal terminal (outside AGY)** after installing the plugin and **before your first `agy` launch**:

**Windows PowerShell:**

```powershell
node "$HOME\.gemini\config\plugins\copilot-api-statusline\scripts\install.js"
agy
```

**macOS / Linux:**

```sh
node "$HOME/.gemini/config/plugins/copilot-api-statusline/scripts/install.js"
agy
```

The script only sets `~/.gemini/antigravity-cli/settings.json` when no non-empty custom statusline command is configured. If you already use another statusline, it returns `skipped-existing` and leaves your configuration intact. Add `--force` to the installer only when you intend to replace it. The directory above is AGY's default global plugin location; use `agy plugin list --json` if you installed into a different location.

If **AGY is already open**, changing the settings JSON may not enable the footer in the current TUI. Restart AGY, or copy the configured `statusLine.command` and run AGY's built-in `/statusline <command>` command to activate it immediately.

The URL points at the plugin **subfolder**, not the root of copilot-api. Recent AGY CLI versions support installing GitHub repository subpaths; use an up-to-date `agy`. If your AGY CLI cannot resolve the GitHub subpath, use the local-directory fallback below.

### Local-directory fallback

```sh
git clone --branch dev --single-branch https://github.com/caozhiyuan/copilot-api.git
agy plugin validate ./copilot-api/plugin/agy/statusline
agy plugin install ./copilot-api/plugin/agy/statusline
agy plugin list
```

You can also validate the GitHub URL directly on AGY versions that support remote validation:

```sh
agy plugin validate https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
```

These commands run in PowerShell, Windows Terminal, bash, or zsh provided `agy`, Git (for the fallback), and Node.js are installed.

## Activate

**Recommended:** Run the installer script above **before launching AGY**. Your custom statusline will be configured on the first launch; there is no need to send `hi` and restart.

**Fallback:** Without the manual setup step, the plugin's `SessionStart` hook attempts to configure `statusLine.command` when your first conversation starts. Since AGY may already have initialized its footer, restart AGY to see the change, or activate it immediately through `/statusline <command>`.

The footer shows model/state, context usage, token/cache statistics, nested subagents, and any quota already reported by AGY. This plugin requires **no Skill** and the copilot-api gateway can remain stopped.

### Already using another statusline?

The plugin intentionally **does not overwrite** an existing statusline with a non-empty command. A placeholder with an empty or whitespace-only `statusLine.command` (for example, `{ "type": "", "command": "", "enabled": true }`) is automatically configured. An explicitly disabled statusline (`enabled: false`) is preserved. If the installation succeeds but the old footer remains, run the installer's explicit override from a checked-out repository:

```sh
node ./copilot-api/plugin/agy/statusline/scripts/install.js --force
```

Or run the same `scripts/install.js --force` file from the **installed plugin directory**. Find that directory with:

```sh
agy plugin list --json
```

On Windows, put double quotes around a script's absolute path if it contains spaces. The installer preserves unrelated settings and updates only the `statusLine` object. Avoid `--force` unless you intend to replace your current footer.

## Display

```text
🤖 Gemini 4 Argon (Medium)  WORKING  SUB 2 RUN | 5 FOUND
CTX [##------------] 14.2% (149K/1.0M)
IN 2.4M | OUT 161K | LAST 96.2% | SESSION 93.8%
QUOTA gemini-weekly: 94%
```

The numbers above are illustrative.

| Field | Meaning |
| --- | --- |
| `SUB N RUN` | Running subagents reported in the current AGY statusline JSON |
| `N FOUND` | Distinct subagent conversation IDs found in local parent/child metadata and transcripts, including nested agents |
| `CTX` | Main agent's native context usage; **not** an automatic compaction threshold |
| `IN / OUT` | Aggregated transcript usage of the main agent and reachable nested subagents |
| `LAST` | Cache-read ratio of the last main-agent model request |
| `SESSION` | Best-effort cache-read ratio across available logs for the current conversation and nested subagents |
| `QUOTA` | Quota fields already supplied by AGY's statusline payload; no extra quota/API polling |

`SESSION` and `FOUND` depend on the transcript/metadata files AGY actually writes, which can be absent, delayed, or version-dependent. Missing transcript data produces `N/A` rather than a fabricated percentage. A child counted as `FOUND` is **not** necessarily counted in token usage if its log is missing.

## Privacy and data flow

- Statusline input: the JSON payload provided to the command by AGY.
- Session totals: **read-only** access to local `transcript_full.jsonl` / `transcript.jsonl` files and locally discoverable child-agent metadata.
- Disk writes: small local JSON caches containing numeric counters and child conversation IDs, to avoid reparsing unchanged logs.
- No Google internal API calls, credentials, network usage, or copilot-api gateway requests.

## Manage, update, and uninstall

```sh
agy plugin list
agy plugin disable copilot-api-statusline
agy plugin enable copilot-api-statusline
agy plugin uninstall copilot-api-statusline
```

To update the plugin, reinstall it from the same GitHub subfolder. If a statusline already points at an older installation path, run the installed `scripts/install.js --force` once to refresh the path.

**Uninstalling does not automatically remove the user-owned `statusLine` setting.** Run `/statusline delete` inside AGY, or manually remove only the `statusLine` entry from `~/.gemini/antigravity-cli/settings.json`, to restore the default footer.

## Custom local paths

The statusline also accepts these optional environment variables:

- `GEMINI_HOME` — replace the default `~/.gemini` directory.
- `ANTIGRAVITY_CLI_HOME` — replace the CLI directory.
- `ANTIGRAVITY_BRAIN_DIR` — replace the root directory of conversation logs.
- `ANTIGRAVITY_STATUSLINE_CACHE` — replace the numeric summary-cache directory.

## Development and troubleshooting

From a checkout of copilot-api:

```sh
node --check plugin/agy/statusline/scripts/statusline.js
node --check plugin/agy/statusline/scripts/install.js
node --test plugin/agy/statusline/scripts/statusline.test.js
agy plugin validate ./plugin/agy/statusline
```

- **Nothing changes after installation**: upgrade/reinstall plugin v1.0.1, restart AGY, and start a **new conversation**. Use `/hooks` to confirm the `statusline-setup` SessionStart hook loaded. Empty `statusLine.command` placeholders are now auto-configured. A non-empty custom command is deliberately preserved; use the manual `--force` override above only if you want it replaced.
- **`SESSION N/A`**: local transcripts were not found or have not yet been written. Check the AGY version and optional log path variables.
- **Plugin fails to install from GitHub**: upgrade AGY and try the local-directory fallback, which does not depend on GitHub URL branch/subpath resolution.
- **No footer at all**: verify that `node` works in the environment running AGY, inspect `agy plugin list --json`, and check the `statusLine` setting.
- **AGY hook validation fails**: run `agy plugin validate ./plugin/agy/statusline` and review the exact error before continuing.

The plugin ships with Node.js unit tests, but **live installation on each operating system and actual AGY transcript formats still need integration verification**.

Official references: [Antigravity plugin guide](https://antigravity.google/docs/plugins?tab=cli) · [Build plugins](https://antigravity.google/docs/build-plugins/).
