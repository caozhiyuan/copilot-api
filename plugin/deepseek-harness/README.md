# copilot-api-provider for DeepSeek Harness

[中文](README.zh-CN.md)

An independent Harness bundle with **strict TypeScript source and built JavaScript distribution**. Harness loads ordinary JS, with no TypeScript loader required. No Harness fork, gateway patch, or duplicated Responses/Messages converter is required. Tested against Harness `0.2.1-rc.2` (`687f282e8625`) and its pi-ai `1.1.0`.

## Install and configure

For a source checkout, install the development dependencies and build once before adding the directory to your existing Harness profile:

```sh
cd /absolute/path/copilot-api/plugin/deepseek-harness
bun install
bun run build
dsh plugin --profile web add /absolute/path/copilot-api/plugin/deepseek-harness
```

`bun run build` checks Host and browser types separately, emits Host JS and declarations into `dist/`, and bundles the browser entry into Harness's module-factory format using its shared React. Generated files are not committed. `npm pack` runs the build automatically and includes the built JS/declarations and display resources; users of that package do not need TypeScript installed.

The bundle inserts the `copilot-api-provider` entry. Add this override to that profile's `cordis.patch.yml` (keep this entry ID for the companion Models card):

```yaml
- id: copilot-api-provider
  config:
    baseURL: http://localhost:4141
    apiKey: COPILOT_API_KEY
    protocol: openai-responses
    headers:
      X-Custom-Header: custom-value
    modelRefreshInterval: 120000
    sessionAffinity: true
```

`apiKey` is a **Harness credential reference**, not the literal key. Store the literal through the Models card's **Save API key** action, Harness's existing credential management, or the launch environment named `COPILOT_API_KEY`. `apiKeyEnv` is an equivalent spelling; if both are supplied, they must agree. With neither specified, the reference is `COPILOT_API_KEY`. The key is resolved again for every inference attempt, including Harness retries. It is never printed by this plugin.

For Messages, change only `protocol` to `anthropic-messages`. Both `http://localhost:4141` and `http://localhost:4141/v1` work. A deployment prefix such as `/gateway` is retained. Discovery uses `/v1/models`; inference uses `/v1/responses` or `/v1/messages`. The Anthropic SDK itself appends `/v1/messages`, so the plugin gives it the parent base URL. URLs containing embedded credentials, query strings, or fragments are rejected.

The Models settings card lists discovered model IDs, names, image capability, context/output capacity and **the exact efforts available in the conversation selector**. Models are fetched on startup and on first use, with an optional periodic refresh. Its Refresh models button also performs a refresh. `modelRefreshInterval` is in milliseconds; the default `0` disables periodic refresh. Failed refreshes keep the last successful directory; active/prepared calls retain their captured models and transport settings.

## Models and thinking

| Gateway field | Harness/pi-ai metadata |
| --- | --- |
| `id` | Exact model ID, including provider prefix |
| `name` / `display_name` | Display name; falls back to ID |
| `context_window` | `contextWindow`; missing/invalid: 8192 |
| `max_output_tokens` | `maxTokens`; missing/invalid: min(1024, context window) |
| `input_modalities` | Text input and explicitly advertised image input |
| `reasoning_efforts` | Actual selectable thinking levels and wire mappings |

No image or thinking support is guessed from a model name. Unknown modalities/efforts are ignored. Discovered output capacity does not become a configured request cap. Prices are not advertised by this endpoint: pi-ai cost fields are zero/unknown; native token counts and session usage accounting remain intact.

Responses supports advertised `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; advertised `none` adds Harness `off`. For example, selecting `high` sends `reasoning: { effort: "high", summary: "auto" }`. Selecting `off` sends explicit `none` only when supported. A bare `off` advertisement does not establish a wire-level disabling mechanism. When no effort is selected, the native pi-ai default behavior applies; omission is not a claim that thinking is disabled.

Messages reuses pi-ai's adaptive thinking and `output_config.effort`, offering only advertised `low`, `medium`, `high`, `xhigh`, `max`. Its named effort vocabulary cannot faithfully represent Responses `none`/`minimal`, so these are not offered on that protocol. A per-model `compat.forceAdaptiveThinking: false` override selects pi-ai's existing budget-based thinking path for a deployment requiring it.

Images use Harness's existing durable attachment access and pi-ai image projection. Use the normal image attachment UI with an image-capable model; no special image switch is required. The shared runtime retains its normal text fallback for models without image support.

Override individual metadata without changing model identity:

```yaml
- id: copilot-api-provider
  config:
    baseURL: http://localhost:4141
    apiKey: COPILOT_API_KEY
    protocol: openai-responses
    modelOverrides:
      codex/gpt-5.4:
        name: My gateway model
        contextWindow: 128000
        maxTokens: 16000
        input: [text, image]
        reasoningEfforts:
          off: none
          high: high
          xhigh: xhigh
```

Copy the actual model ID from your directory. Overrides apply only to discovered models. A name-only override preserves other discovered capabilities; `reasoningEfforts: false` removes thinking controls. `modelOverrides` is a native volatile settings field: editing it in the generated plugin settings refreshes the directory live. Connection fields use the loader's normal configuration remount. A patch replaces the entry's entire `config`, so restate connection options you need.

## Headers, sessions and cache

Static headers merge case-insensitively with SDK headers. Gateway credentials, protocol version/content type, SDK Accept, Harness User-Agent, Host/content length, and dynamic session headers take priority over configured values. Anthropic beta tokens are combined with required SDK beta tokens. The Harness User-Agent prevents Claude CLI-specific discovery formatting from changing IDs.

Each inference attempt carries `x-deepseek-harness-session-id` from its actual Harness `GenerateOptions.sessionId`. `sessionAffinity: true` additionally sends `x-session-affinity` with that same ID; the default is false. The current API does not expose a reliable root Session ID here, so children retain their own IDs. Discovery has no synthetic session. The plugin does not alter session IDs, usage/log ownership, or add user data. It removes pi-ai's `x-client-request-id` only when pi-ai has populated it with the session ID.

`prompt_cache_key` stays a request-body field owned by pi-ai. Neither session header toggles nor affinity alter it, and no second cache key is created. Native protocol conversion, SSE, tool/replay state, thinking, usage, AbortSignal and Harness retry behavior all remain with `PiAiAdapter` and the existing runtime.

## Architecture and verification

`src/index.ts` registers the adapter, configurable-provider directory, discovery callback and owned lifecycle. `src/catalog.ts` publishes complete immutable model generations. `src/models.ts` translates directory metadata only. `src/provider.ts` supplies typed public pi-ai Provider descriptors to the existing `PiAiAdapter`, delegates both streams to pi-ai's public lazy API implementations, and injects a header-only fetch wrapper from `src/transport.ts`. `src/client/index.ts` uses the public `settings.models.provider-card` slot, resource and credential APIs. No Harness internals are imported by runtime files.

For development, use Node 24, install this plugin's test dependencies, and use a current, dependency-installed Harness source checkout for its testkit and standard decorator transform:

```sh
cd plugin/deepseek-harness
bun install
HARNESS_SOURCE=/absolute/path/deepseek-harness env -u NODE_USE_ENV_PROXY bun run test --coverage
bun test --coverage tests/models.bun.test.ts
bun run typecheck
```

`bun run test` first builds the distribution. Harness must have its library artifacts built for peer resolution. The integration configuration also resolves its source test helpers. Use the same Harness installation/checkout for all peer packages to preserve Cordis and runtime singleton identity. Tests use local HTTP/SSE fixtures and real Harness/pi-ai; no live upstream provider key is needed. `bun run typecheck` checks strict Host/browser TypeScript without emitting files; it enables implicit-any errors, override checks and checked indexed access. Build tests additionally load the generated Host entry in plain Node and the generated browser factory with shared React. See the PR for exact checks and coverage. Browser UI behavior is tested in jsdom; a running desktop/browser deployment is not part of that test.
