# 配置参考

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/configuration.md)

<a id="configuration-configjson"></a>

## 配置（config.json）

- **位置：** Linux/macOS 为 `~/.local/share/copilot-api/config.json`，Windows 为 `%USERPROFILE%\.local\share\copilot-api\config.json`。
- **默认结构：**
  ```json
  {
    "auth": {
      "apiKeys": [],
      "adminApiKey": "<startup 自动生成>"
    },
    "providers": {},
    "modelMappings": {},
    "smallModels": {
      "codex": "gpt-6-luna",
      "copilot": "gpt-6-luna"
    },
    "contextManagement": {
      "messages": true,
      "responses": false
    },
    "opencodeModelContextWindow": 300000,
    "modelResponsesApiCompactThresholds": {
      "gpt-5.4": 217600,
      "gpt-5.5": 217600
    },
    "useMessagesApi": true,
    "useResponsesApiWebSocket": true,
    "upstreamTransport": {
      "headersTimeoutMs": 300000,
      "streamInactivityTimeoutMs": 300000,
      "websocketOpenTimeoutMs": 30000,
      "websocketPoolIdleTimeoutMs": 60000,
      "websocketMaxBufferedBytes": 8388608,
      "websocketMaxBufferedMessages": 1024
    },
    "useResponsesApiWebSearch": true,
    "alphaSearchCodexPriority": true,
    "alphaSearchModel": "gpt-6-luna",
    "messageApiWebSearchModel": "gpt-6-luna"
  }
  ```
- **auth.apiKeys：** 用于普通非 admin 路由的 API key。支持多个 key 轮换使用。请求可通过 `x-api-key: <key>` 或 `Authorization: Bearer <key>` 进行认证。若为空或省略，仅回环监听会禁用普通路由认证；非回环监听会拒绝启动。
- **auth.adminApiKey：** 仅用于 `/admin/*` 路由的单个 admin key。若未配置，服务会在启动时自动生成一个随机 key，并回写到 `config.json`。它同样使用 `x-api-key` 或 `Authorization: Bearer` 这两种头，但普通 `auth.apiKeys` 不能访问 `/admin/*`。
- **modelMappings：** 用于顶层 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`POST /v1/responses` 和 `POST /v1/chat/completions` 请求的精确 `sourceModel -> targetModel` 重写映射，这几类接口共用同一份规则。默认映射为 `codex-auto-review -> codex/codex-auto-review` 和 `gpt-reserve -> codex/gpt-reserve`；省略该字段、保留为 `{}` 或配置其他模型时，都会补齐缺少的默认映射。同名项以用户配置为准，启动和保存映射时会将合并结果写回 `config.json`。如需取消某条默认重写，可将其映射到自身，例如 `"gpt-reserve": "gpt-reserve"`。`source` 和 `target` 都必须是非空字符串。`target` 可以是普通模型 ID，也可以是 `provider/model` 形式的别名，例如 `dashscope/qwen3.6-plus`；重写发生在 provider alias 解析之前。这些映射不再按接口区分。`GET/POST /admin/config/model-mappings` 管理接口读写的也只有这个字段。
- **extraPrompts：** `model -> prompt` 的映射。把 Anthropic 风格请求翻译为 Responses API 时，会将其附加到第一条 system prompt 后面。你可以借此为不同模型注入护栏或指引。对于 GPT-5.3+ 模型（如 `gpt-5.3-codex`、`gpt-5.4`、`gpt-5.5`），未显式配置时会自动使用内置的 commentary prompt。内置 prompt 会启用带阶段感知的 commentary，让模型在工具调用或更深层推理前先发出简短的用户可见进度说明。
- **providers：** 全局上游 provider 映射。每个 provider key（例如 `dashscope`）都会变成一个路由前缀（`/dashscope/v1/messages`）。支持 `type: "anthropic"`、`type: "openai-compatible"` 和 `type: "openai-responses"`。顶层客户端也可以在 `/v1/messages`、`/v1/messages/count_tokens`、`/v1/responses` 和 `/v1/chat/completions` 中使用 `model: "dashscope/model-id"`；AI gateway 会在转发上游前移除 `dashscope/` 前缀。`anthropic` 和 `openai-compatible` provider 的 `/v1/responses` 会通过 Responses Lite → Messages 适配；其中 `openai-compatible` provider 再复用 Messages → Chat 翻译。Codex 客户端（`User-Agent` 以 `codex` 开头）在 `openai-responses` provider 上请求非 `gpt-*` 模型时同样走该适配路径。`GET /v1/models` 会聚合已启用 provider 的模型，并以 `provider/model-id` 形式返回；Codex UA 的顶层模型列表还会把这些可适配模型合并为 `use_responses_lite` 模型（DeepSeek 模型除外，它们使用 `use_responses_lite: false` 和 `tool_mode: null`）。单个 provider 的原始模型列表仍可使用 `GET /dashscope/v1/models`。
  - `enabled`：可选，若省略则默认为 `true`。
  - `agentsModels`：可选，填写 Codex 和 Claude Code 网关发现列表展示的上游原始模型 ID；省略表示自动发现，`[]` 表示不展示该 provider 的模型。无需添加 `my-claude-` 或网关 provider 前缀。显式名单覆盖 Codex 默认排除规则，不限制模型调用或其他客户端的列表。
    旧 `codexModels` 名单会在启动或保存配置时迁移为 `agentsModels`。若同时存在两个字段，以 `agentsModels` 为准（包括空数组），旧字段会从磁盘配置中移除。
  - `baseUrl`：手动填写 provider 时使用其 API 基础 URL，不要带结尾的 endpoint。Anthropic provider 不要带 `/v1/messages`；OpenAI 兼容 provider 不要带 `/v1/chat/completions`；OpenAI Responses provider 不要带 `/v1/responses`。
  - `modelsDevProviderId`：可选，通过自定义授权选择 models.dev provider 时写入。此时 `baseUrl` 为 models.dev 提供的 API URL（也可编辑），网关直接追加 `/messages`、`/chat/completions` 或 `/responses`。缓存目录中的模型级协议和 USD 价格元数据在可用时生效；仅当 `baseUrl` 与目录中的 provider API URL 一致时，才应用模型级 API URL 覆盖。显式配置的 `models.<id>.pricing` 优先。手动填写的 provider 仍使用 `baseUrl` 加 `/v1/<endpoint>`。
  - `apiKey`：作为上游凭据值使用；除 `authType` 为 `azure-entra` 外，普通 provider 必须配置。
  - `authType`：可选，控制上游认证方式。普通 provider 支持 `x-api-key`、`authorization` 和 `azure-entra`。Anthropic provider 默认 `x-api-key`；OpenAI 兼容和 OpenAI Responses provider 默认 `authorization`。`authorization` 会发送 `Authorization: Bearer <apiKey>`。`azure-entra` 使用 Azure Identity 的 `DefaultAzureCredential` 和 `https://cognitiveservices.azure.com/.default` scope 获取并发送 Bearer token，不需要配置 `apiKey`。Azure OpenAI v1 endpoint 可配置为 `{ "type": "openai-compatible", "baseUrl": "https://<resource-name>.openai.azure.com/openai", "authType": "azure-entra" }`。本地可先执行 `az login`，在 Azure 中可使用托管身份，也可设置标准的 `AZURE_TENANT_ID`、`AZURE_CLIENT_ID` 和 `AZURE_CLIENT_SECRET` 环境变量。`oauth2` 仅保留给内置 `codex` provider，并由 `auth login --provider codex` 自动写入。
  - `accountId`：仅用于内置 `codex` provider，记录当前选中的 Codex 账号。CLI 或桌面端切换账号时自动更新。
  - `pricingCurrency`：可选，显式配置 token 单价的币种，例如 `USD` 或 `CNY`。快捷 provider 默认 DashScope、DeepSeek 为 `CNY`，Codex、Kimi、OpenCode Go、OpenRouter 为 `USD`。models.dev 目录价格始终按 USD 使用。费用按币种分别汇总，不做汇率换算。
  - `models`：可选，按模型 ID 配置的映射。每个键为请求中的模型名，值支持：
    - `temperature`：可选，当请求未指定时使用的默认温度。
    - `topP`：可选，当请求未指定时使用的默认 `top_p`。
    - `topK`：可选，当请求未指定时使用的默认 `top_k`。
    - `extraBody`：可选，按模型合入上游请求体的动态字段；请求体显式同名字段优先。OpenAI 兼容 provider 可用它配置 `enable_thinking`、`preserve_thinking`、`reasoning_effort` 等字段。`thinking_budget` 是 OpenAI 兼容 provider 的特殊覆盖项：配置在 `extraBody` 后，会在 Anthropic `thinking.budget_tokens` 翻译之后强制写入，并覆盖请求派生出的预算值。对于 provider name 为 `dashscope` 或 `baseUrl` 包含 `aliyuncs.com` 的 provider，请求派生的 `thinking_budget`（来自 Anthropic `thinking.budget_tokens`）会转发给上游；其他 OpenAI 兼容 provider 会移除请求派生的 `thinking_budget`，但 `extraBody` 中的 `thinking_budget` 仍然生效。对于 DashScope provider，当 `preserve_thinking` 未在 `extraBody` 或请求体中显式设置时，默认为 `true`。
    - `pricing`：可选，按模型配置 token 单价，币种使用 provider 的 `pricingCurrency`，单位为每 100 万 tokens。支持 `input`、`output`、`cachedInput`（隐式缓存读）、`explicitCachedInput`（显式缓存读）和 `cacheCreationInput`。如需按输入 token 总量分档，可用带 `maxInputTokens` 的 `tiers`。分时计费可配置 `offPeak` 声明闲时单价，并用 `peakWindows` 声明忙时时段：每项包含 UTC 当日分钟数 `startMinuteUtc`（含）、`endMinuteUtc`（不含），可选 `weekdays` 为 ISO 星期号（1 表示周一，7 表示周日）。未配置 `peakWindows` 时不使用闲时价格。未配置单价时使用匹配目录的 models.dev 价格。
    - `contextCache`：可选，provider name 为 `dashscope` 或 `baseUrl` 包含 `aliyuncs.com` 时默认 `true`，其他 OpenAI 兼容 provider 默认 `false`。用于启用阿里云百炼/DashScope 的显式缓存（explicit context cache），会按其 Context Cache 格式在最多 4 个 content block 上注入 `cache_control: { "type": "ephemeral" }`。缓存断点策略与 opencode 主链路保持一致：前 2 条 system 消息 + 最后 2 条非 system 消息。标记字符串 content 时会把 `system` / `user` / `assistant` / `tool` 消息转换为 text content part 数组；已有数组 content 则标记最后一个 part。如果模型本身已经支持隐式缓存，或上游不支持该显式缓存扩展字段，可在模型配置中设为 `false`。支持相同显式缓存扩展的非 DashScope provider 可设为 `true`。同时适用于 `/v1/messages` 和 `/v1/chat/completions` 路由。
    - `supportPdf`：可选，覆盖 OpenCode 模型发现和 Messages 到 Chat Completions 转换时的 PDF/document 支持能力。未配置时，识别匹配的 models.dev 模型 `modalities.input` 中的 `pdf`（遵循 `modelsDevProviderId`）、Copilot 实时模型的 `application/pdf` 媒体类型，以及 `codex` provider 的默认支持；其余情况为 `false`。设为 `true` 时发送 file part，设为 `false` 时即使目录支持 PDF 也会转成提示文本。
    - `toolContentSupportType`：可选，配置该模型的 tool result content 支持能力，值为 `array`、`image`、`pdf` 的数组。provider 侧未配置时默认只发送 string tool content。PDF 支持已启用但这里不包含 `pdf` 时，tool result 里的 file part 会被转成 user role 消息。Copilot 主链路同样默认只发送 string tool content，因为部分 Copilot 模型也不支持数组或图片形式的 tool content。
    - `type`：可选，按模型覆盖 provider 的协议类型。支持 `anthropic`、`openai-compatible` 和 `openai-responses`。设置后，provider 的 `/v1/messages` 路由会使用该模型的 type 替代 provider 级别的 type 进行请求路由、认证头解析和上游端点选择。适用于 OpenCode Go 等上游对不同模型同时支持 OpenAI 兼容和 Anthropic Messages API 的 provider。覆盖 type 时，认证头按覆盖后 type 的默认值解析（Anthropic 默认 `x-api-key`；OpenAI 兼容/Responses 默认 `authorization`）。配置了 `azure-entra` 的 provider 在覆盖 type 时会保留 Entra bearer 凭证，而不会回退到覆盖后 type 的默认值。
    - `contextWindow`：可选，模型合并到 Codex UA 模型列表时声明的上下文窗口 token 上限；例如 `1000000` 表示 1M token 上下文。用户未配置时依次使用发现元数据、models.dev 目录和 `256000`。
    - `maxOutputTokens`：可选，Codex UA 模型列表中声明的最大输出 token 数。用户未配置时依次使用发现元数据、models.dev 的 `limit.output` 和 `32000`。经 Messages 适配的 Responses 请求未传 `max_output_tokens` 或传 null 时，使用此配置、目录上限或 `32000`；Copilot 请求使用模型声明的输出上限。目录匹配优先使用 `modelsDevProviderId`，否则按 provider 名称和官方地址选择。客户端显式传入的值优先。
    - `inputModalities`：可选，Codex 支持的输入类型；模型同时支持文本和图片时配置为 `["text", "image"]`。用户未配置时使用发现元数据或 models.dev 目录。GPT 模型继续使用原生 Codex catalog 或发现元数据。
    - `reasoningEfforts`：可选，Codex 支持的推理档位。配置和发现元数据均未提供时，使用 models.dev 目录，再回退到 `["high", "xhigh", "max", "ultra"]`。已知模型能力时，Provider Responses 请求中的不支持档位会被归一化为支持的档位。
    - `defaultReasoningEffort`：可选，Codex 默认推理档位；未配置时优先取可用的 `max`，否则取第一个支持的档位。合成 Codex 模型始终启用并行工具调用。
    - `reasoningField`：可选，OpenAI-compatible `/v1/messages` 转发 assistant 思考文本时使用的字段，支持 `reasoning` 与 `reasoning_content`，默认 `reasoning_content`；OpenRouter 风格模型设为 `reasoning`，OpenCode Go 的 Hy 系列模型会根据 models.dev 的 family 元数据使用 `reasoning` 字段。
- **smallModels：** 按 provider 指定 Codex 客户端 `/v1/responses` 标题请求的模型。`codex`、`copilot` 默认使用 `gpt-6-luna`；其他 provider 仅在配置同名键时切换（如 `smallModels.dashscope`）。模型须受对应 provider 支持；设为空字符串可禁用切换。标题提示词须出现在最后两个 input 项之一的 user `input_text` 中。`copilot` 也用于非 token-based 计费账户的 Claude Code 无工具预热；旧 `smallModel` 不再生效。
- **opencodeModelContextWindow：** OpenCode 模型目录（携带 OpenCode User-Agent 的 `GET /v1/models`）中 `limit.context` 和已有 `limit.input` 的 token 上限，默认 `300000`。两个字段分别在超过上限时截断，较小值保持不变，未提供的 input 上限不会补填。不修改 `limit.output`、上游实际限制或其他客户端的模型目录。正数会向下取整；缺失、无效、零或负数回退到默认值。启动合并配置时会将归一化后的值写入 `config.json`。
- **contextManagement：** 控制代理是否为 Responses API 附加 `context_management` 压缩指令。`messages` 作用于被翻译成 Responses API 的 Anthropic 风格 `/v1/messages` 请求，包括 `openai-responses` provider 的 Messages 路由，默认值为 `true`。`responses` 作用于 native `/v1/responses` 流量，包括 `provider/model` 别名和内置 `codex` provider，默认值为 `false`。只有在确认客户端支持 context management compaction 后，才建议在 Responses API 下启用 `responses`。启用后，请求体会带上 `context_management`，并在后续轮次中仅保留最新的压缩承载内容。代理仅为 `gpt-*` 模型添加 context management 并压缩历史；这两个配置开关对 Grok 等非 GPT 模型不生效。**注意：** 对于 GPT-5.6 及以上模型（如 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`），context management 功能同样会被强制禁用，因为开启后会破坏这些模型的 prompt 缓存命中。这些强制覆盖优先于 `contextManagement` 和 `modelResponsesApiCompactThresholds` 配置。
 - **modelResponsesApiCompactThresholds：** 按模型覆盖 Responses API 的 `compact_threshold`，仅在代理自动附加 `context_management` 时使用。它的优先级高于 `resolveResponsesCompactThreshold` 基于 `max_prompt_tokens * ratio` 的兜底阈值。默认将 `gpt-5.4` 和 `gpt-5.5` 设为 `217600`（`272000 * 0.8`）。未列出的模型继续使用原有兜底逻辑。
- **modelReasoningEfforts：** `/v1/messages` 请求的模型级默认推理强度。仅当请求没有传入 `output_config.effort` 时，该配置才会生效。
  - **优先级：** 请求中的 `output_config.effort` > `modelReasoningEfforts[model]` > 内置默认值（GPT-5.3+ 模型为 `xhigh`，其他模型为 `high`）。
  - **转发字段：** 走 Copilot 原生 Messages API 时，最终值写入 `output_config.effort`；转换为 Responses API 时，最终值写入 `reasoning.effort`。
  - **配置可选值：** `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。
- **useMessagesApi：** 当为 `true` 时，声明了 Copilot 原生 `/v1/messages` 端点的模型会使用 Messages API。如果所选模型未声明 Messages 端点或关闭了该配置，网关会在模型声明了 Responses 端点时使用 Responses，否则在模型支持时回退到 Chat Completions。设为 `false` 可跳过原生 Messages 路由。默认值为 `true`。
- **useResponsesApiWebSocket：** 当为 `true` 时，Copilot Responses 请求会对声明了 `ws:/responses` 的模型使用 WebSocket；仅声明 `/responses` 的模型使用 HTTP。内置 `codex` provider 的流式 Responses 请求只要启用了该配置就会使用 WebSocket，非流式 Codex 请求始终使用 HTTP。设为 `false` 后，Copilot 会在所选模型声明了 `/responses` 时使用 HTTP，Codex 的流式 Responses 请求也会改走 HTTP。WebSocket 失败后不会自动通过 HTTP 重试。默认值为 `true`。如果代理、VPN 或网络会阻断或干扰 WebSocket 流量，请关闭该配置或切换网络。使用 GitHub Copilot provider 时遇到 `Encrypted function output content could not be decrypted or decoded`，同样把该配置设为 `false`，详见[故障排查](troubleshooting.md#troubleshooting)。
- **upstreamTransport：** 上游 chat completions、responses、messages 三类请求共用的生命周期与缓冲区正整数限制。无效值、零或负数会回退到上面列出的默认值。`headersTimeoutMs` 从连接建立开始计算，到收到 HTTP 响应头为止，并不是整个生成过程的总时限。每收到一个 HTTP body chunk 或 WebSocket message 都会重置 `streamInactivityTimeoutMs`，因此持续活跃的长推理任务不会被短总时限中断。`websocketOpenTimeoutMs` 限制 WebSocket 握手时间；`websocketPoolIdleTimeoutMs` 只控制已正常完成且可复用的空闲连接。WebSocket 队列同时受字节数和消息数上限约束；超过任一上限时会终止该 stream 并使 socket 失效，而不会丢弃或重排事件。
- **useResponsesApiWebSearch：** 当为 `true` 时，服务端会保留 Responses API 中 `type: "web_search"` 的工具并透传到上游。设为 `false` 则会从 `/responses` payload 中移除这些工具。默认值为 `true`。
- **alphaSearchCodexPriority：** 默认值为 `true`。顶层 alpha-search 请求优先使用 Codex alpha-search 端点，因为它不会消耗 provider 配额。若 Codex 不可用，或该配置设为 `false`，使用非 `codex/model` 的 `provider/model` 别名的请求会调用目标 provider 的 `/v1/responses` 端点，没有 provider 前缀的请求使用 GitHub Copilot Responses web search。该适配器会识别当前所有 Codex search command；不受支持的 `image_query` 和 `screenshot` 会返回成功且明确要求不要重试的 tool output。
- **alphaSearchModel：** Messages-backed 的 Responses Lite 模型不能直接执行 Responses web search 时使用的原生 Responses 搜索模型，默认值为 `gpt-6-luna`。可以配置普通 Copilot 模型或 `openai-responses` 类型的 `provider/model`；设为空字符串可禁用，此时这类模型的 alpha-search 请求会返回参数错误。
- **messageApiWebSearchModel：** 顶层 Copilot `/v1/messages` 请求只包含服务端 `web_search` 工具时使用的全局模型，默认值为 `gpt-6-luna`。如果该值是 `provider/model` 别名，请求会进入对应 provider 的 Messages API 路径，并在转发前移除 provider 前缀。对于 Copilot GPT 模型，web search 会通过 `/responses` 执行。混合 `web_search` 与自定义工具的场景暂不支持，服务端会移除 server-side `web_search`。
- **claudeAutoModel：** 用于 Claude Code 后台 security-monitor 请求的模型，作用于 `/v1/messages` 和 provider Messages 路由。当请求不带任何工具、`stop_sequences` 为 `["</block>"]`，且 system 文本块以 `You are a security monitor for autonomous AI coding agents.` 开头时，会被识别为 security-monitor 请求，其模型会被替换为该配置值。用户显式配置对两类路由均生效，且优先于默认值。未配置时，只有顶层 `/v1/messages` 使用动态默认值：已启用的 `codex` provider 默认使用 `codex-auto-review`，否则只有 `github-copilot` 开关允许且运行时 GitHub token 与 Copilot token 均已加载时，才默认使用 `gpt-6-luna`（未配置 Copilot 开关时视为启用）。Codex 优先；不满足任何默认条件时不替换模型，未授权的 Copilot 不会触发默认切换。显式设为空字符串可禁用。默认值随 provider 配置和 Copilot 凭据状态动态选择，不写回 `claudeAutoModel`。对于顶层请求，替换后的模型会应用 `modelMappings`，默认将 `codex-auto-review` 转发到 `codex/codex-auto-review`；`provider/model` 别名会转发到对应 provider 的 Messages API。provider 专属路由（如 `/dashscope/v1/messages`）仅使用显式配置的非空 `claudeAutoModel`；未配置时保留请求中的模型。显式配置生效时保持当前 provider，直接使用配置值，不应用 `modelMappings`。
- **claudeTokenMultiplier：** 用于 Claude `/v1/messages/count_tokens` 请求在本地走 GPT tokenizer 估算时的乘数。默认值为 `1.15`。如果你的客户端仍然过晚触发上下文压缩，可以适当调大。这个配置只会在代理本地估算 Claude token 时生效；如果已经配置 `anthropicApiKey` 且 Anthropic token counting 调用成功，则会直接返回 Anthropic 的精确计数，不会使用这个乘数。
- **anthropicApiKey：** 用于把 Claude `/v1/messages/count_tokens` 请求转发到 Anthropic 真实 token counting 端点的 API key，这样会返回精确计数，而不是 GPT tokenizer 估算值。也可通过环境变量 `ANTHROPIC_API_KEY` 设置。若未配置，或上游调用失败，则回退到由 `claudeTokenMultiplier` 控制的本地 GPT tokenizer 估算。

**Codex 目录：** 普通 JSON 响应不超过 1 MiB，不限制模型数量。显式 provider 名单优先；候选超过 20 个时，未配置 `agentsModels` 的来源应用默认排除名单。完整本地导出绕过大小及默认排除限制，仍遵守启停状态和显式名单。

**Provider 管理：** 桌面端“模型映射”前的“Provider 管理”标签页可启停已配置的 provider、编辑“Coding Agent 展示模型”名单，服务停止时也可使用；授权页也保留管理入口。CLI 命令为 `copilot-api provider enable <name>` 和 `copilot-api provider disable <name>`，支持 `--api-home`。`enabled` 控制所有客户端的 Provider 路由，`agentsModels` 筛选 Codex 模型目录和 Claude Code 网关发现列表。停用保留凭据和模型配置；Copilot 继续使用独立授权方式。

![Provider 管理界面](../../screenshots/provider-management.png)

编辑此文件后即可自定义 prompts，或替换为你自己的快速模型。修改完成后请重启服务（或重新执行命令），让缓存中的配置刷新生效。

内置 GitHub Copilot 也支持统一管理：`providers["github-copilot"]` 只需配置 `enabled`，可选 `agentsModels`，无需 URL、API Key 或协议类型。旧配置没有这一项时默认启用，继续使用已有 GitHub 登录凭据。使用 `copilot-api provider disable github-copilot` / `copilot-api provider enable github-copilot`，或在 Providers 页面切换后保存并重启网关。禁用会跳过 Copilot 初始化，从所有客户端的模型列表移除其模型并拒绝 Copilot 请求，其他启用的 provider 可继续使用。
