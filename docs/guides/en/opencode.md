# OpenCode

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/opencode.md)

## Using with OpenCode

OpenCode already has a direct GitHub Copilot provider. Use this section when you want OpenCode to discover models from this AI gateway and reuse the [plugin integrations](integrations.md#plugin-integrations). The v2 plugin uses Responses; the legacy v1 example below uses Anthropic Messages.

### OpenCode v2: automatic model discovery

After starting the gateway, copy [`plugin/opencode/copilot-api-provider.js`](../../../plugin/opencode/copilot-api-provider.js) into your project's `.opencode/plugins/copilot-api-provider.js` and restart OpenCode v2. Use `~/.config/opencode/plugins/` to load it globally. This is a single JS file with no dependencies; you do not need to maintain a `models` configuration.

The plugin connects to `http://localhost:4141/v1` through v2's bundled `@opencode/ai/providers/openai/responses` package using Responses, with `settings.compaction: { "type": "native" }`. It discovers models at startup and refreshes every 20 seconds. The provider is named `My Local`, and models appear as `local/<model ID>`. Discovery respects enabled gateway providers and `agentsModels`. Failed refreshes keep the last successful catalog and retry on the next interval.

With the current OpenCode v2 OpenAI Responses runtime, native compaction prefers a `compaction_trigger` appended to `input` on a regular `/v1/responses` request. The standalone `/v1/responses/compact` mechanism is used only when the route has no trigger support but does expose endpoint compaction; this gateway does not expose that standalone endpoint. Native compaction still requires the selected upstream model or gateway adapter to support the trigger. Reasoning variants use Responses `reasoning.effort`, not Anthropic `output_config.effort`.

Environment variables:

- `GITHUB_COPILOT_API_KEY`: the same gateway API key used by Codex; defaults to `dummy`.
- `COPILOT_API_URL`: optionally overrides the gateway's `/v1` URL.

Discovery requests include `opencode` in the User-Agent so the gateway returns the v2 model structure. Capabilities, limits and prices reuse the matching provider's models.dev catalog, or `modelsDevProviderId` when configured. Gateway model settings and live upstream capabilities can override catalog limits. Prices include input, output, cache reads and writes, and context tiers, in USD per million tokens. Gateway model price settings override catalog prices; CNY prices, configured or built in, are converted at a fixed 6.7 rate and rounded to six decimals, while prices in other currencies are not returned as USD. Models with no known USD pricing have an empty `cost` array.

PDF input is supported by default for the `codex` provider. For `github-copilot`, the gateway also recognizes `application/pdf` in the live model's `capabilities.limits.vision.supported_media_types`. For any provider, `pdf` in the matching models.dev model's `modalities.input` also enables PDF support; catalog lookup respects `modelsDevProviderId`. An explicit `models.<id>.supportPdf` setting takes priority over all these sources, including `false` to disable PDF support. OpenCode discovery and Messages-to-Chat-Completions request translation use the same PDF capability rules. If the upstream does not support PDF in tool results, the gateway moves the file parts to user messages.

The gateway's `config.json` setting `opencodeModelContextWindow` defaults to `300000`. It caps the discovered `limit.context` and any existing `limit.input` independently; smaller values remain unchanged and a missing input limit stays omitted. If no context limit is known, the catalog falls back to `256000` tokens before applying this ceiling. It does not change output limits, upstream model configuration, or other clients' catalogs. For example, set `"opencodeModelContextWindow": 500000` to use a higher ceiling, then restart the gateway to reload the configuration.

### OpenCode v1: minimal setup

Start the AI gateway with the OpenCode OAuth app:

```sh
npx @jeffreycao/copilot-api@latest auth --oauth-app=opencode
npx @jeffreycao/copilot-api@latest start
```

Then point OpenCode at the gateway with `@ai-sdk/anthropic`.

Example `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "local": {
      "npm": "@ai-sdk/anthropic",
      "name": "My Local",
      "options": {
        "baseURL": "http://localhost:4141/v1",
        "apiKey": "dummy"
      },
      "models": {
        "gpt-5.4": {
          "name": "gpt-5.4",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 400000,
            "input": 272000,
            "output": 128000
          }
        },
        "claude-sonnet-4.6": {
          "id": "claude-sonnet-4.6",
          "name": "claude-sonnet-4.6",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },          
          "limit": {
            "context": 200000,
            "output": 32000
          },
          "options": {
            "thinking": {
              "type": "adaptive"
            },
            "effort": "max"
          }
        }
      }
    }
  }
}
```

Why these fields matter:

- `npm: "@ai-sdk/anthropic"` is the important part. OpenCode will speak Anthropic Messages semantics to this AI gateway instead of flattening everything into OpenAI Chat Completions.
- `options.baseURL` should be `http://localhost:4141/v1`; the Anthropic SDK will append `/messages`, `/models`, and `/messages/count_tokens` automatically.
- If you enable `auth.apiKeys` in this AI gateway, replace `dummy` with a real key. Otherwise any placeholder value is fine.
