# Claude Code

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/claude-code.md)

## Using with Claude Code

This AI gateway can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

Start the gateway, then configure Claude Code through `settings.json`:

```sh
bunx --bun @jeffreycao/copilot-api start
```

### Manual Configuration with `settings.json`

Create a `.claude/settings.json` file in your project's root directory with the environment variables Claude Code needs to use the gateway.

Here is an example `.claude/settings.json` file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "gpt-6.1-sol[1m]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "gpt-6.1-sol[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-6.1-sol[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-6-luna[1m]",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000",
    "CLAUDE_CODE_AUTO_MODE_SERVER": "0",
    "CLAUDE_CODE_USE_VERTEX": "0",
    "CLAUDE_CODE_USE_BEDROCK": "0",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "true",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
    "CLAUDE_CODE_TOTAL_TOKENS_REMINDER": "off",
    "CLAUDE_CODE_EFFORT_LEVEL": "max",
    "MCP_CONNECT_TIMEOUT_MS": "20000"
  },
  "alwaysThinkingEnabled": true,
  "showThinkingSummaries": true
}
```

- `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"` enables gateway models in Claude Code's `/model` picker. See the [official gateway configuration guide](https://code.claude.com/docs/en/llm-gateway-connect#add-gateway-models-to-the-model-picker). For requests whose User-Agent contains `claude` (case-insensitive), `/v1/models` adds `my-claude-` to model names that do not already contain `claude`, preserving the provider prefix, and appends `[1m]` to every model ID regardless of its context window: `opencode-go/glm-5.3-flash` becomes `opencode-go/my-claude-glm-5.3-flash[1m]`, while `claude-opus-4-8` becomes `claude-opus-4-8[1m]`. Messages and token-counting requests remove the compatibility prefix and `[1m]` suffix before model mappings and provider routing. Other clients retain the existing model IDs.
- The desktop's **Models shown in Coding Agent** selection applies to both Codex and Claude Code discovery through `agentsModels`; selections use original upstream model IDs without `my-claude-`, `[1m]`, or the gateway provider prefix.
- Model display names identify their provider, for example `GLM-5.3-Flash (opencode-go)`. Existing labels are used as the base; a matching provider prefix or suffix is not repeated. Copilot entries use `github-copilot`.
- Replace `ANTHROPIC_DEFAULT_FABLE_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` according to your needs. After configuration, please install the claude code plugin [Plugin Integrations](integrations.md#plugin-integrations).  
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off"` disables Claude Code's total-tokens reminder, which injects a `<total_tokens>N tokens left</total_tokens>` block into the conversation to pace the model against a remaining token budget. The default budget is 15,000,000 (15M) tokens, which is not very meaningful, so it is turned off here.
- Setting CLAUDE_CODE_ATTRIBUTION_HEADER to 0 can prevent Claude code from adding billing and version information in system prompts, thereby avoiding prompt cache invalidation.
- Turning off CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION and CLAUDE_CODE_ENABLE_AWAY_SUMMARY can prevent quota from being consumed unnecessarily.
- Claude Code WebSearch is supported for pure search requests. For Copilot, keep the global `messageApiWebSearchModel` set to a Responses-capable GPT model or a `provider/model` alias. For provider routes, use a native Anthropic provider or an `openai-responses` provider. Add `WebSearch` to `permissions.deny` only if you want to forbid this traffic.
- If using a non-Claude model, do not enable ENABLE_TOOL_SEARCH. If using the Claude model, can enable ENABLE_TOOL_SEARCH. The current Claude Code uses the client tool search mode. In this mode, loading defer tools requires an additional request each time.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW`: Set the context capacity in tokens used for auto-compaction calculations. Defaults to the model's context window: 200K for standard models or 1M for extended context models. Use a lower value like `500000` on a 1M model (e.g., `claude-opus-4-6[1m]`) to treat the window as 500K for compaction purposes. The value is capped at the model's actual context window. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` is applied as a percentage of this value. Setting this variable decouples the compaction threshold from the status line's `used_percentage`, which always uses the model's full context window.

- `CLAUDE_CODE_PROMPT_CACHE_TTL`: In Claude Code v2.1.242+, set this to `1h` to request a one-hour prompt cache for Claude models; API key sessions default to five minutes. The gateway forwards the client-requested `extended-cache-ttl-2025-04-11` beta and `cache_control.ttl` on content blocks to Copilot Messages without adding a one-hour TTL itself. This setting does not apply to GPT models. Configure other requests, including subagents, separately with `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`. See [Claude Code's prompt caching docs](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself) for precedence rules.
  - **Risk notice:** [GitHub Copilot's official pricing documentation](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) does not currently list a separate price for a one-hour cache. Although the Copilot models API returns `cache_write_1h_price`, that field is not public confirmation of the one-hour cache billing rules. Use this feature cautiously; availability and charges depend on the upstream service.

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)
