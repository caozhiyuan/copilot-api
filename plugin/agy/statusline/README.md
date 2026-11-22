# Copilot API Statusline for Antigravity CLI

A standalone, local-only AGY plugin shipped with copilot-api. It does **not** proxy Antigravity models or contact the copilot-api gateway. No Skill, OAuth access, internal ConnectRPC, or third-party dependencies are needed.

## Install

From a checkout of the repository, run:

    agy plugin validate ./plugin/agy/statusline
    agy plugin install ./plugin/agy/statusline

Restart agy and start a conversation. The plugin's SessionStart hook automatically adds statusLine.command to ~/.gemini/antigravity-cli/settings.json **only if no statusline is already configured**. Existing custom statuslines and unrelated settings are preserved.

To explicitly replace an existing statusline, use the installer from the installed plugin directory (typically ~/.gemini/config/plugins/copilot-api-statusline/):

    node ~/.gemini/config/plugins/copilot-api-statusline/scripts/install.js --force

On Windows, quote the installer path if it contains spaces. The script also works directly from a checkout: node ./plugin/agy/statusline/scripts/install.js --force.

No gateway or Antigravity model proxy is required. Works on Windows, macOS, and Linux with Node.js 20+.

## Display

    Gemini 4 Argon (Medium)  WORKING  SUB 2 RUN | 5 FOUND
    CTX ███░░░░░░░░░░░ 14.2% (149K/1.0M)
    IN 2.4M | OUT 161K | LAST 96.2% | SESSION 93.8%
    QUOTA gemini-weekly: 94%

- LAST is the most recent main-agent cache-read ratio, from the official statusline stdin JSON.
- SESSION estimates the cache-read ratio for the current conversation and recursively discovered subagents using on-disk transcripts.
- SUB shows live running subagents from the CLI JSON and total distinct subagent IDs discovered through local metadata/transcripts.
- CTX shows model-advertised context usage, not the automatic compaction threshold.
- IN/OUT aggregate transcript usage. Missing transcripts produce N/A, not invented totals.

SESSION statistics are **best-effort**. Logs can be absent, delayed, incomplete, or changed by an AGY release. The script only reads local transcript files and stores numeric summary caches; it never uploads transcript text.

## Manual setup and conflict handling

The plugin has **no Skill**. SessionStart configures the statusline on the first conversation and does nothing on subsequent sessions if already configured. It never silently replaces a different user's custom statusline. Use --force only when you explicitly want to switch to this statusline.

AGY supports statusLine.command directly. If you do not want its startup hook, configure the command manually in ~/.gemini/antigravity-cli/settings.json instead.

## Uninstall

Run agy plugin uninstall copilot-api-statusline, then use /statusline delete in AGY (or remove statusLine from ~/.gemini/antigravity-cli/settings.json). AGY has no documented plugin uninstall hook.

## Optional paths

- GEMINI_HOME: override the .gemini directory
- ANTIGRAVITY_CLI_HOME: override CLI data directory
- ANTIGRAVITY_BRAIN_DIR: override conversation brain directory
- ANTIGRAVITY_STATUSLINE_CACHE: override local summary cache

## Development

    node --check plugin/agy/statusline/scripts/statusline.js
    node --check plugin/agy/statusline/scripts/install.js
    node --test plugin/agy/statusline/scripts/statusline.test.js

The AGY CLI itself is needed to validate or install the plugin. The Node.js tests do not require AGY.
