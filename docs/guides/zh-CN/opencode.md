# OpenCode

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/opencode.md)

<a id="using-with-opencode"></a>

## 与 OpenCode 一起使用

OpenCode 已经有直接的 GitHub Copilot provider。本节适用于你希望让 OpenCode 动态发现这个 AI gateway 的模型，并使用[插件集成](integrations.md#plugin-integrations)提供的 agent 行为时。v2 插件使用 Responses，下方旧版 v1 示例使用 Anthropic Messages。

### OpenCode v2：自动发现模型

启动网关后，将仓库中的 [`plugin/opencode/copilot-api-provider.js`](../../../plugin/opencode/copilot-api-provider.js) 复制到项目的 `.opencode/plugins/copilot-api-provider.js`，重启 OpenCode v2 即可。也可以放到 `~/.config/opencode/plugins/`，供所有项目使用。插件是单个 JS 文件，无需安装依赖或手动维护 `models`。

默认连接 `http://localhost:4141/v1`，使用 v2 内置的 `@opencode/ai/providers/openai/responses` 包，通过 Responses 协议访问网关，并设置 `settings.compaction: { "type": "native" }`。插件启动时发现模型，每 20 秒刷新一次，provider 名称为 `My Local`，模型选择器中显示为 `local/<模型 ID>`。发现范围遵循网关的 provider 启用状态与 `agentsModels`；刷新失败时保留上次成功的目录，等待下次重试。

当前 OpenCode v2 的 OpenAI Responses runtime 在 native 压缩时，优先在普通 `/v1/responses` 请求的 `input` 末尾追加 `compaction_trigger`。仅当路由不支持 trigger、但提供 endpoint 压缩时才会使用独立的 `/v1/responses/compact`；本网关没有该独立端点。实际压缩仍需所选上游模型或网关适配器支持 trigger。推理档位使用 Responses 的 `reasoning.effort`，不再使用 Anthropic 的 `output_config.effort`。

环境变量：

- `GITHUB_COPILOT_API_KEY`：与 Codex 共用的网关 API Key；未配置时使用 `dummy`。
- `COPILOT_API_URL`：可选，覆盖默认的网关 `/v1` 地址。

模型目录请求的 User-Agent 包含 `opencode`，网关因此返回 v2 模型结构。模型能力、上下文限制和价格复用对应 provider 的 models.dev 数据；配置了 `modelsDevProviderId` 时使用该目录，网关里的模型配置与上游实时能力可覆盖目录的限制。价格包括输入、输出、缓存读写和上下文分档，单位为美元/百万 token。网关里的模型价格配置可覆盖目录价格；人民币价格（配置或内置）按固定 6.7 汇率换算为美元并保留 6 位小数，其他币种不会当成美元返回；没有已知美元价格时，`cost` 为空数组。

`codex` provider 默认支持 PDF 输入；`github-copilot` 也会识别实时模型的 `capabilities.limits.vision.supported_media_types` 中的 `application/pdf`。所有 provider 还会识别匹配的 models.dev 模型 `modalities.input` 中的 `pdf`，目录匹配遵循 `modelsDevProviderId`。显式 `models.<id>.supportPdf` 配置优先于以上来源，包括用 `false` 关闭 PDF 支持。OpenCode 模型发现和 Messages 到 Chat Completions 的请求转换复用同一套 PDF 能力判断；上游不支持 tool result 中的 PDF 时，会将 file part 移到 user 消息中。

网关 `config.json` 中的 `opencodeModelContextWindow` 默认值为 `300000`，分别限制目录返回的 `limit.context` 和已有的 `limit.input`；较小值保持不变，缺失的 input 上限不补填。模型没有已知上下文限制时，目录使用 `256000` tokens 兜底，再应用此配置上限。不改变输出上限、上游模型配置或其他客户端目录。例如设置 `"opencodeModelContextWindow": 500000` 可提高该上限，修改后重启网关加载配置。

### OpenCode v1：最小配置

使用 OpenCode OAuth app 启动 AI gateway：

```sh
npx @jeffreycao/copilot-api@latest auth --oauth-app=opencode
npx @jeffreycao/copilot-api@latest start
```

然后让 OpenCode 通过 `@ai-sdk/anthropic` 指向这个 AI gateway。

示例 `~/.config/opencode/opencode.json`：

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

这些字段的重要性：

- `npm: "@ai-sdk/anthropic"` 是关键。OpenCode 会以 Anthropic Messages 语义与这个 AI gateway 通信，而不是把一切扁平化为 OpenAI Chat Completions。
- `options.baseURL` 应设为 `http://localhost:4141/v1`；Anthropic SDK 会自动补上 `/messages`、`/models` 和 `/messages/count_tokens`。
- 如果你在此代理中启用了 `auth.apiKeys`，请把 `dummy` 替换为真实 key；否则任意占位值都可以。
