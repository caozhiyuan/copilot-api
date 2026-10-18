# DeepSeek Harness：copilot-api-provider

[English](README.md)

独立插件包，采用**严格 TypeScript 源码，构建为 JavaScript 交付**，复用 Harness 的 `PiAiAdapter`、LLM Runtime 和 pi-ai 的 Responses/Messages 实现。Harness 加载普通 JS，不需要 TypeScript loader。无需修改 Harness 或 copilot-api 服务端。验证版本为 Harness `0.2.1-rc.2`（`687f282e8625`）和其使用的 pi-ai `1.1.0`。

## 安装与配置

从源码安装时，先安装开发依赖并构建一次，再将目录加入已有 Harness profile：

```sh
cd /absolute/path/copilot-api/plugin/deepseek-harness
bun install
bun run build
dsh plugin --profile web add /absolute/path/copilot-api/plugin/deepseek-harness
```

构建会分别检查 Host 与浏览器类型，将 Host JS 和类型声明输出到 `dist/`，并将浏览器入口打包为 Harness 要求的模块工厂，继续使用其共享 React。构建产物不提交到仓库。`npm pack` 自动执行构建，包内包含构建后的 JS、类型声明和展示资源；使用该分发包时无需安装 TypeScript。

插件包会插入 `copilot-api-provider` 条目。在该 profile 的 `cordis.patch.yml` 中添加覆盖配置；保留此条目 ID，供模型设置插槽识别：

```yaml
- id: copilot-api-provider
  config:
    baseURL: http://localhost:4141
    apiKey: GITHUB_COPILOT_API_KEY
    protocol: openai-responses
    headers:
      X-Custom-Header: custom-value
    modelRefreshInterval: 120000
    sessionAffinity: true
```

`apiKey` 填 **Harness 凭据引用名**，不能填密钥明文。在模型设置的 Copilot API 卡片中点击“保存 API 密钥”，或使用已有凭据管理、启动环境变量 `GITHUB_COPILOT_API_KEY` 保存实际密钥。也支持 `apiKeyEnv`；两者同时配置时必须相同。未配置时默认引用 `GITHUB_COPILOT_API_KEY`。每次推理尝试（包括 Harness 重试）重新解析凭据，轮换密钥无需重启。插件不会打印密钥。

使用 Messages 只需将 `protocol` 改为 `anthropic-messages`。地址**带或不带 `/v1` 都可以**，`/gateway` 等部署前缀会保留。模型发现使用 `/v1/models`，推理使用 `/v1/responses` 或 `/v1/messages`。Anthropic SDK 自己拼接 `/v1/messages`，插件会提供对应的上级地址，不会产生双重 `/v1`。地址不能包含内嵌用户名/密码、查询参数或 fragment。

模型设置卡片显示自动发现的名称、原始 ID、图片输入能力、上下文/输出上限，以及**对话模型选择器实际可选的思考等级**。启动、首次使用和手动刷新均可发现模型。`modelRefreshInterval` 单位为毫秒，默认 `0` 关闭定时刷新。刷新失败保留上次成功目录；已准备或执行中的调用保持其捕获的模型和传输配置。

## 模型、思考等级与图片

| copilot-api 字段 | Harness/pi-ai 字段或行为 |
| --- | --- |
| `id` | 完整保留，包括 Provider 前缀 |
| `name` / `display_name` | 名称，缺失时回退到 ID |
| `context_window` | `contextWindow`，缺失/无效时回退到 8192 |
| `max_output_tokens` | `maxTokens`，缺失/无效时取 min(1024, 上下文窗口) |
| `input_modalities` | 文本，以及明确声明的图片输入 |
| `reasoning_efforts` | 实际可选思考等级及其协议映射 |

不会从模型名称猜测图片或思考能力；忽略未知模态和等级。发现的输出容量不会自动成为每次请求的输出限制。此接口未提供价格，pi-ai 的费用字段为零/未知；原有 Token Usage 计数和 Session 归属继续保留。

Responses 展示模型声明的 `minimal`、`low`、`medium`、`high`、`xhigh`、`max`；只有声明了 `none` 才添加 Harness 的 `off`。选择 `high` 时实际发送 `reasoning: { effort: "high", summary: "auto" }`；选择 `off` 时显式发送 `none`。单独的 `off` 声明不足以确定协议能关闭思考。不选择等级时沿用 pi-ai 默认行为，省略参数不等于承诺关闭思考。

Messages 复用 pi-ai 的 adaptive thinking 和 `output_config.effort`，仅展示模型声明的 `low`、`medium`、`high`、`xhigh`、`max`。该协议的命名 effort 不能准确表达 Responses 的 `none`/`minimal`，因此不展示它们。部署需要旧版预算式 thinking 时，可对单个模型设置 `compat.forceAdaptiveThinking: false`，使用 pi-ai 原有预算转换。

图片沿用 Harness 附件存储、读取和 pi-ai 图片投影。在普通输入框上传图片，选择声明支持图片的模型即可，不需要额外开关。不支持图片的模型保留共享 Runtime 原有的文本回退行为。

单模型覆盖示例（替换成目录中的真实 ID）：

```yaml
- id: copilot-api-provider
  config:
    baseURL: http://localhost:4141
    apiKey: GITHUB_COPILOT_API_KEY
    protocol: openai-responses
    modelOverrides:
      codex/gpt-5.4:
        name: 我的网关模型
        contextWindow: 128000
        maxTokens: 16000
        input: [text, image]
        reasoningEfforts:
          off: none
          high: high
          xhigh: xhigh
```

覆盖只作用于发现的模型，不修改 ID；只覆盖名称时保留其余能力。`reasoningEfforts: false` 可关闭该模型的思考等级控件。`modelOverrides` 使用 Harness 原生 volatile 设置，在自动生成的插件设置中修改后即时刷新。连接字段沿用 Loader 的正常配置重载。patch 会替换整个条目的 `config`，请一并保留所需连接选项。

## Header、会话与缓存

静态 Header 大小写不敏感。认证、协议版本与 Content-Type、SDK Accept、Harness User-Agent、Host/Content-Length、动态 Session Header 优先于静态配置。Anthropic Beta 按 token 合并，保留 SDK 必需项。User-Agent 使用 Harness 的真实版本，避免触发 Claude CLI 专用模型目录格式。

每次实际推理发送当前 `GenerateOptions.sessionId` 对应的 `x-deepseek-harness-session-id`。`sessionAffinity: true` 时再发送同值的 `x-session-affinity`，默认关闭。该接口没有可靠 Root Session ID，子 Agent 保留自己的 Session ID。模型发现不合成会话。插件不改变日志、追踪、Token Usage 的会话归属，也不发送用户敏感信息。保留 pi-ai/SDK 原有的 `x-client-request-id`，即使其值与 Session ID 相同也不移除。

`prompt_cache_key` 始终由 pi-ai 在请求体中管理。开启 Session Header 或 affinity 不改变其值，也不另建缓存键。SSE、工具调用、多轮回放、thinking、用量、AbortSignal 和 Harness 重试继续由原生适配器处理。

## 开发与验证

`src/index.ts` 注册 Adapter、Provider 目录、模型发现及生命周期；`src/catalog.ts` 发布不可变的模型代际；`src/models.ts` 只解析目录元数据；`src/provider.ts` 用有类型约束的公开 pi-ai Provider 接口向原有 `PiAiAdapter` 提供模型，并委托公开 lazy API 实现处理协议；`src/transport.ts` 只处理请求 Header；`src/client/index.ts` 使用公开模型卡片插槽、资源和凭据接口。运行时代码不导入 Harness 私有文件。

测试使用 Node 24，需要已安装依赖、已构建库产物的最新 Harness 源码目录：

```sh
cd plugin/deepseek-harness
bun install
HARNESS_SOURCE=/absolute/path/deepseek-harness env -u NODE_USE_ENV_PROXY bun run test --coverage
bun test --coverage tests/models.bun.test.ts
bun run typecheck
```

`bun run test` 会先构建分发产物。所有 Harness peer 包应来自同一安装或源码目录，保证 Cordis/Runtime 单例一致。集成测试复用其 testkit、源码测试辅助函数和标准 decorator 转换。使用本地 HTTP/SSE 服务，不需要上游账号或真实密钥。`bun run typecheck` 分别严格检查 Host/浏览器源码，不生成文件，开启隐式 any 检查、override 检查和索引访问检查。另有构建测试确认普通 Node 可加载 Host JS，浏览器工厂可使用共享 React。检查结果及覆盖率见 PR。浏览器组件在 jsdom 中验证，未将运行中的桌面/浏览器部署作为测试条件。
