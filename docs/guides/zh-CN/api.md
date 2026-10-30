# API 与认证

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/api.md)

<a id="api-authentication"></a>

## API 认证

- **受保护的普通路由：** 当配置了 `auth.apiKeys` 且非空时，除 `/`、`/usage-viewer` 和 `/usage-viewer/` 以外的普通路由都需要认证。非回环监听要求启动时存在非空的 `auth.apiKeys`，即使运行期间 Key 被清空也会继续以拒绝请求的方式安全失败。
- **Admin 路由：** 所有 `/admin/*` 路由都要求 `auth.adminApiKey`。如果缺失，服务会在启动时自动生成并在开始提供服务前写回 `config.json`。
- **允许的认证头：**
  - `x-api-key: <your_key>`
  - `Authorization: Bearer <your_key>`
- **CORS 预检：** `OPTIONS` 请求始终允许。
- **未配置普通 key 时：** 普通路由仍可直接访问；但这条规则不适用于 `/admin/*`，后者只接受 `auth.adminApiKey`。

普通受保护路由的示例请求：

```sh
curl http://localhost:4141/v1/models \
  -H "x-api-key: your_api_key"
```

Admin 路由的示例请求：

```sh
curl http://localhost:4141/admin/config/model-mappings \
  -H "x-api-key: your_admin_api_key"
```

<a id="api-endpoints"></a>

## API 端点

服务端提供多个 OpenAI / Anthropic 兼容端点。请求会根据所选模型和 `provider/model` 别名路由到 GitHub Copilot、内置 `codex` provider 或已配置的 provider。支持 provider 级路径的端点使用 `/:provider/v1/...` 形式；视频端点仅提供顶层路由。

### OpenAI 兼容端点

这些端点模拟 OpenAI API 结构。

| 端点                        | 方法 | 说明                                                                                                     |
| --------------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `POST /v1/responses`        | `POST` | OpenAI 中用于生成模型响应的高级接口。支持 `Content-Encoding: zstd` 请求体和 `openai-responses` provider 的 `provider/model` 别名。zstd 请求解压仅作用于 Responses 路由，包括 provider-scoped 别名路由。 |
| `POST /v1/chat/completions` | `POST` | 为给定聊天对话创建模型响应。支持 `openai-compatible` provider 的 `provider/model` 别名；目标 provider 已配置时可在没有 Copilot 的情况下使用。 |
| `GET /v1/models`            | `GET` | 列出 Copilot 模型以及已启用 provider 的 `provider/model-id` 模型。来自 Codex 客户端（`User-Agent` 以 `codex` 开头）的请求会转发到 Codex Models 上游。 |
| `POST /v1/embeddings`       | `POST` | 创建表示输入文本的向量嵌入。                                                                             |

### 模型发现来源

`GET /models`、`GET /v1/models` 和 `GET /:provider/v1/models` 从 models.dev 缓存读取 `xai`、`openrouter`、`deepseek`、`kimi`、`dashscope`、`opencode-go` 的模型，不查询这些 provider 的远程模型接口。Kimi 默认使用 `kimi-code-plan-cn`，DashScope 默认使用 `alibaba-cn`；其他官方地址匹配对应目录，显式 `modelsDevProviderId` 优先。

目录中缺失的聊天模型不补入内置聊天模型列表。provider 级接口没有有效缓存模型时返回 `503`（`service_unavailable`），顶层列表跳过空目录。模型能力、窗口和 USD 价格来自目录，显式模型配置优先。

OpenAI 格式的聚合目录 `GET /models` 和 `GET /v1/models` 默认包含可用 provider 的 Codex 和 xAI 内置图片模型。桌面端 Dashboard 的 Available Models 和网页端 Models 标签页直接使用普通模型接口，无需额外查询参数。采用 agent 筛选的客户端仍会对图片模型应用 `agentsModels`；客户端专用目录格式保持现有行为。

所有 models.dev 模型列表过滤已弃用及 `release_date` 早于 `2026-05-01` 的模型，显式展示名单也遵循此规则；没有有效日期的模型保留。

Codex model catalog、Copilot 模型缓存和其他自定义 provider 的远程发现保持原有行为。

### Codex 后端端点

这些端点实现 Codex 后端 API。路由到 Codex 的图片请求要求已有可用的 Codex 登录态；路由到已配置 provider 的图片请求使用该 provider 的凭据。alpha-search 则可以使用 Codex 后端或 Responses web-search 适配器。

| 端点                                                       | 方法 | 说明                                                                                                 |
| ---------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/alpha/search`            | `POST` | 将 Codex alpha-search 请求路由到 Codex 后端，或在本地及通过 Responses web search 处理支持的命令。 |
| `POST /v1/images/generations` | `POST` | 将 JSON 图片生成请求转发到 Codex Images 上游。请求未携带 `Content-Type` 时，网关默认补充 `application/json`。请求 `model` 命中已配置的 model mapping 时会被改写；映射结果为已配置 provider 的 `provider/model` 别名时，请求将转发到该 provider 的 images 端点。 |
| `POST /v1/images/edits` | `POST` | 接受 JSON 图片引用或 `multipart/form-data` 上传。JSON 保持现有行为，支持 `images: [{ image_url }]`、`images: [{ file_id }]` 和可选的 `mask` 引用。multipart 支持 `image`、`image[]`、重复图片字段及可选 `mask`，并保留图片出现顺序；文件先流式落盘，发往 Codex 或 xAI 时再转换为 base64 data URL 和 JSON。支持 model mapping 与 `provider/model` 别名。`/codex/v1/images/edits` 和 `/xai/v1/images/edits` 同样接受 multipart；其他 provider 作用域路由保持透传行为。 |

multipart 上传总大小上限为 128 MiB，单文件上限为 64 MiB，最多 16 个文件；超限返回 `413`，格式错误返回 `400`。转换为 JSON 后，以及失败或取消时，都会清理临时文件。base64 图片数据约增大三分之一，生成的 JSON 会在转发前缓存在内存中。xAI 仍最多接受 5 张图片，不支持 mask、file_id 和流式输出。通过 model mapping 选中的其他 provider 继续接收 multipart。

当 `imageGenerationModel` 或 `imageEditModel` 配置为 `xai/model` 别名时，对应的顶层图片路由会把 OpenAI 图片请求翻译后发到已启用的 `xai` provider 的 Imagine 接口，上游模型由该别名决定。配置为空时仍走上面的 OpenAI 转发路径。这两项目前不接受其他 provider。

对于路由到 Codex 后端的请求，网关会使用当前 Codex 登录态覆盖客户端的 authorization 和 account header，并保留兼容的请求元数据。基于 Responses 的 alpha-search 则遵循所选 Copilot 或 provider 的路由。

### xAI 视频端点

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/videos/generations` | `POST` | 提交 xAI 原生异步视频生成请求。`model` 使用 `xai/grok-imagine-video-1.5`，或映射到该模型的 model mapping 名称，返回上游 `request_id`。 |
| `/v1/videos/{request_id}` | `GET` | 查询任务状态和视频 URL，使用与提交时相同的 xAI 账号及上游地址。 |

两个端点也支持省略 `/v1`，沿用普通网关鉴权，使用已启用 `xai` provider 的 API key 或 OAuth 凭据。`model` 没有默认值，缺失或不支持的模型返回 `400`，provider 不可用返回 `404`。其余原生生成字段交由上游校验，图片和参考素材输入会原样转发。上游响应体、状态码及元数据保持不变。

提交生成请求：

```sh
curl http://localhost:4141/v1/videos/generations \
  -H 'Authorization: Bearer your_gateway_key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"xai/grok-imagine-video-1.5","prompt":"A paper boat on a lake","duration":5}'
```

响应包含上游 `request_id`，使用该 ID 轮询结果：

```sh
curl http://localhost:4141/v1/videos/YOUR_REQUEST_ID \
  -H 'Authorization: Bearer your_gateway_key'
```

网关不等待生成完成、不重试提交，也不保存任务。查询期间需保持同一 xAI 账号和上游地址。客户端处理 `pending`、`done`、`failed` 等原生状态，并直接访问返回的 `video.url`。xAI 默认视频 URL 为临时地址，详见 [xAI 视频文档](https://docs.x.ai/developers/model-capabilities/video/generation)。

### Anthropic 兼容端点

这些端点设计为兼容 Anthropic Messages API。

| 端点                                                          | 方法 | 说明                                                                                                 |
| ------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/messages`                                           | `POST` | 为给定对话创建模型响应。支持已配置 provider 的 `provider/model` 别名，包括通过 `openai-compatible` 和 Google Gemini 原生协议（`google`）provider 做翻译。 |
| `POST /v1/messages/count_tokens`                              | `POST` | 计算一组消息的 token 数。支持已配置 provider 的 `provider/model` 别名。                          |

### 使用量监控端点

用于监控 Copilot 用量与额度的新端点。

| 端点           | 方法 | 说明                                              |
| -------------- | ---- | ------------------------------------------------- |
| `GET /usage`   | `GET` | 获取详细的 Copilot 使用统计与额度信息。          |
| `GET /usage/github-copilot` | `GET` | 获取统一格式的 Premium、Chat 和 Completions 订阅额度。 |
| `GET /usage/codex` | `GET` | 获取当前 Codex 订阅的额度窗口、Credits 和 Business 成员额度上限。 |
| `GET /usage/xai` | `GET` | 获取当前 xAI 订阅的 Grok Build 额度和预付余额。 |
| `GET /usage/opencode-go` | `GET` | 获取 OpenCode Go 滚动 5 小时、每周及每月的用量百分比与重置时间。 |

OpenCode Go 使用已配置的 provider API key 和 base URL 查询 `GET /v1/usage`；旧地址 `https://opencode.ai/zen/go` 沿用现有规范化逻辑，转为 `https://opencode.ai/inference/go`。不会根据百分比推算金额上限或套餐等级。工作区没有 Go 额度时，与其他不可用订阅一致返回 404。

订阅接口使用服务端已启用的提供商和当前选中的账号，返回统一的 `provider`、`planType`、`windows`、`credits` 和额度限制状态，`resetAt` 使用 Unix 秒时间戳，Copilot 的日历重置日期使用 `resetDate`，额度窗口可通过 `unlimited` 表示无限制。订阅不可用时返回 404，上游或凭据查询失败时返回 502。桌面端和网页的订阅额度标签页分别查询这些接口，上游凭据保留在服务端。

### Admin / 配置端点

这些端点用于本地管理操作，只接受 `auth.adminApiKey`。

| 端点                                 | 方法 | 说明                                                            |
| ------------------------------------ | ---- | --------------------------------------------------------------- |
| `GET /admin/config/model-mappings`   | `GET` | 返回当前 `config.json` 路径以及生效中的 `modelMappings` 映射。 |
| `POST /admin/config/model-mappings`  | `POST` | 只更新 `config.json` 里的 `modelMappings` 字段，并回传更新后的结果。 |
| `POST /admin/config/reload` | `POST` | 重新读取配置并刷新当前服务进程，无需重启。 |

刷新接口无需请求体，返回 `{ configPath, reloaded: true }`。修改 admin key 后，用修改前仍在生效的 key 发起刷新；无效 JSON 会保留上一次生效的配置。桌面端保存网关配置后会自动调用此接口。
