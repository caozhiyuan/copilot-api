# Copilot API Statusline for Antigravity CLI

[简体中文](README.zh-CN.md) | English

A standalone statusline plugin for Antigravity CLI (`agy`) in the [copilot-api](https://github.com/caozhiyuan/copilot-api) repository. It uses the CLI's status payload and local conversation logs.

Works on **Windows, macOS, and Linux** with Node.js 20+ (no npm dependencies).

## Install from GitHub (recommended)

Install the plugin directly from the `dev` branch:

```sh
agy plugin install https://github.com/caozhiyuan/copilot-api/tree/dev/plugin/agy/statusline
agy plugin list
```

### Show the statusline on the first launch

After installing the plugin, run the setup script in your terminal before launching AGY.

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

The paths above use AGY's default global plugin directory. Run `agy plugin list --json` to find the actual installation path.

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

In AGY, run `/install-statusline` to configure the plugin, then restart AGY to display the footer. To load it in the current session, pass the saved `statusLine.command` to AGY's `/statusline <command>`.

### Already using another statusline?

The plugin preserves existing custom commands and explicitly disabled statuslines (`enabled: false`). A placeholder with an empty or whitespace-only `statusLine.command` is automatically configured.

To switch to this plugin, find the installed directory with `agy plugin list --json`, then run this command from that directory.

```sh
node ./scripts/install.js --force
```

Use the installer in a source checkout for local development. It registers the script path inside that checkout, which must stay in place while the command is configured.

## Display

```text
🤖 Gemini 4 Argon (Medium)  WORKING  SUB 2 RUN | 5 FOUND | WORKFLOW AGENTS 8
CTX [##------------] 14.2% (149K/1.0M)
IN 2.4M | OUT 161K
CACHE HIT  Last request 96.2% | Session 93.8%
QUOTA gemini-weekly: 94%
```

The numbers above are illustrative.

| Field | Meaning |
| --- | --- |
| `SUB N RUN` | Running subagents reported in the current AGY statusline JSON |
| `N FOUND` | Distinct regular subagent conversations found in local metadata and transcripts, including nested agents |
| `WORKFLOW AGENTS N` | Distinct Workflow Agent conversations found in local task logs and reports |
| `CTX` | Main agent's native context usage; **not** an automatic compaction threshold |
| `IN / OUT` | Aggregated transcript usage of the main agent and discovered subagents and Workflow Agents |
| `CACHE HIT` · `Last request` | Cache hit rate of the last main-agent model request |
| `CACHE HIT` · `Session` | Cache hit rate across available logs for this conversation, including its subagents and Workflow Agents |
| `QUOTA` | Quota fields already supplied by AGY's statusline payload; no extra quota/API polling |

Counts update as AGY records child conversation IDs. A Workflow Agent contributes to totals once its transcript contains usage. Token totals show `N/A` until usage is available.

## Privacy and data flow

- Statusline input: the JSON payload provided to the command by AGY.
- Session totals read local `transcript_full.jsonl` / `transcript.jsonl`, child-agent metadata, and the tail of local task logs.
- Disk writes: small local JSON caches containing numeric counters and child conversation IDs, to avoid reparsing unchanged logs.
- No Google internal API calls, credentials, network usage, or copilot-api gateway requests.

## Manage, update, and uninstall

```sh
agy plugin list
agy plugin disable copilot-api-statusline
agy plugin enable copilot-api-statusline
agy plugin uninstall copilot-api-statusline
```

To update, reinstall from the same GitHub subfolder and run `/install-statusline` to refresh the saved command. The terminal installer also refreshes it.

**Uninstalling does not automatically remove the user-owned `statusLine` setting.** Run `/statusline delete` inside AGY, or manually remove only the `statusLine` entry from `~/.gemini/antigravity-cli/settings.json`, to restore the default footer.

## Custom local paths

The statusline also accepts these optional environment variables:

- `GEMINI_HOME` — replace the default `~/.gemini` directory, including the installer's base directory for `antigravity-cli/settings.json`.
- `ANTIGRAVITY_CLI_HOME` — set the statusline's base directory for `brain/` transcripts and the `statusline-cache/` cache.
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

- **The install skill is missing**. Run `/skills reload` or restart AGY after reinstalling the plugin.
- **`Session N/A`**. Local transcripts may be delayed or contain no input usage yet. Check the optional log path variables.
- **Plugin fails to install from GitHub**: upgrade AGY and try the local-directory fallback, which does not depend on GitHub URL branch/subpath resolution.
- **No footer at all**: verify that `node` works in the environment running AGY, inspect `agy plugin list --json`, and check the `statusLine` setting.
- **Plugin validation fails**. Run `agy plugin validate ./plugin/agy/statusline` for details.

The plugin ships with Node.js unit tests, but **live installation on each operating system and actual AGY transcript formats still need integration verification**.

Official references: [Antigravity plugin guide](https://antigravity.google/docs/plugins?tab=cli) · [Build plugins](https://antigravity.google/docs/build-plugins/).
