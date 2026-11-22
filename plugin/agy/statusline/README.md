# Copilot API Statusline for Antigravity CLI

[简体中文](README.zh-CN.md) | English

A standalone, local-only Antigravity CLI (`agy`) statusline plugin bundled with [copilot-api](https://github.com/caozhiyuan/copilot-api). It **does not** proxy Antigravity models, connect to the copilot-api gateway, access OAuth/CSRF tokens, or call internal ConnectRPC APIs. **No Skill or manual slash-command setup is required.**

Works on **Windows, macOS, and Linux** with Node.js 20+ (no npm dependencies).

## Install from GitHub (recommended)

**Preview / PR #541 (before merging into `dev`):**

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/feat/agy-statusline-plugin/plugin/agy/statusline
agy plugin list
```

The URL points at the plugin **subfolder**, not the root of copilot-api. Recent AGY CLI versions support installing GitHub repository subpaths; use an up-to-date `agy`.

**After PR #541 is merged into `dev`**, use:

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
```

> The `dev` command is for **after the merge**. Until then, use the preview branch above. The GitHub URL uses a branch name containing a slash; if your AGY CLI cannot resolve it, use the local-directory fallback below.

### Local-directory fallback

```sh
git clone --branch feat/agy-statusline-plugin --single-branch https://github.com/caozhiyuan/copilot-api.git
agy plugin validate ./copilot-api/plugin/agy/statusline
agy plugin install ./copilot-api/plugin/agy/statusline
agy plugin list
```

You can also validate the GitHub URL directly on AGY versions that support remote validation:

```sh
agy plugin validate https://github.com/caozhiyuan/copilot-api/tree/feat/agy-statusline-plugin/plugin/agy/statusline
```

These commands run in PowerShell, Windows Terminal, bash, or zsh provided `agy`, Git (for the fallback), and Node.js are installed.

## Activate

1. Install the plugin.
2. Start a **new AGY CLI conversation** (restart `agy` if necessary).
3. The plugin's `SessionStart` hook registers `statusLine.command` in `~/.gemini/antigravity-cli/settings.json` **only if a statusline is not already configured**.
4. The footer then displays model/state, context usage, token/cache statistics, subagent counts, and native quota values when available.

This uses a native AGY lifecycle hook, **not a Skill**. There is no `/copilot-api-statusline:...` command to run. The gateway can remain stopped.

### Already using another statusline?

The plugin intentionally **does not overwrite** an existing statusline. If the installation succeeds but the old footer remains, run the installer's explicit override from a checked-out repository:

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
CTX ███░░░░░░░░░░░ 14.2% (149K/1.0M)
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

- **Nothing changes after installation**: restart AGY and open a new conversation. If you already configured a custom statusline, use the manual `--force` override above.
- **`SESSION N/A`**: local transcripts were not found or have not yet been written. Check the AGY version and optional log path variables.
- **Plugin fails to install from GitHub**: upgrade AGY and try the local-directory fallback, which does not depend on GitHub URL branch/subpath resolution.
- **No footer at all**: verify that `node` works in the environment running AGY, inspect `agy plugin list --json`, and check the `statusLine` setting.
- **AGY hook validation fails**: run `agy plugin validate ./plugin/agy/statusline` and review the exact error before continuing.

The plugin ships with Node.js unit tests, but **live installation on each operating system and actual AGY transcript formats still need integration verification**. See [PR #541](https://github.com/caozhiyuan/copilot-api/pull/541).

Official references: [Antigravity plugin guide](https://antigravity.google/docs/plugins?tab=cli) · [Build plugins](https://antigravity.google/docs/build-plugins/).
