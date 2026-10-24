# 网关事件插件

本文对应 `feat/request-event-plugins` 开发分支，尚未发布到 npm。

插件是一个本地 `.mjs` 文件，通过事件获取请求状态和用量。网关负责提供统一事件，插件负责输出 JSONL、运行中请求快照或对接其他监控系统。模型信息复用 handler 已经解析的 payload，插件接口不包含请求正文、响应内容和鉴权 Header。

## 最简示例

新建 `simple-monitor.mjs`：

```js
export default function setup({ version, server, on, log }) {
  log(`插件 API v${version}，监听端口 ${server.port}`)

  on("request.end", (event) => {
    log(JSON.stringify({
      requestId: event.id,
      model: event.model,
      actualModel: event.actualModel,
      userAgent: event.userAgent,
      sessionId: event.sessionId,
      port: event.port,
      durationMs: event.durationMs,
      firstTokenMs: event.firstTokenMs,
      status: event.status,
      outcome: event.outcome,
    }))
  })

  on("usage.recorded", (event) => {
    log(JSON.stringify({
      requestId: event.requestId,
      model: event.model,
      actualModel: event.actualModel,
      inputTokens: event.input_tokens,
      userAgent: event.userAgent,
      sessionId: event.sessionId,
      outputTokens: event.output_tokens,
      totalTokens: event.total_tokens,
    }))
  })

  return () => {
    log("插件已停止")
  }
}
```

在这个开发分支的仓库根目录执行。Windows PowerShell：

```powershell
$env:COPILOT_API_PLUGINS = '["D:/copilot-plugins/simple-monitor.mjs"]'
bun run start start --port 5000
```

macOS / Linux：

```sh
export COPILOT_API_PLUGINS='["/absolute/path/simple-monitor.mjs"]'
bun run start start --port 5000
```

`COPILOT_API_PLUGINS` 是 JSON 数组，可以配置多个插件。绝对路径直接使用；相对路径按 API home 目录解析，即 `COPILOT_API_HOME`，未设置时使用现有应用数据目录，不按终端当前目录解析。修改插件列表或插件代码后需重启服务。配置不是合法 JSON 路径数组时启动会报错；单个插件导入或 setup 失败时会记录日志并跳过该插件。

## 插件 API

默认导出的 setup 函数可以是异步函数，也可以返回一个同步或异步的退出清理函数。

| 参数 | 含义 |
| --- | --- |
| `version` | 插件 API 版本，当前为 `1` |
| `server.pid` | 网关进程 PID |
| `server.port` | 配置的监听端口，不从客户端 Host Header 推断 |
| `on(name, handler)` | 订阅事件，返回取消订阅函数；handler 可返回 Promise |
| `log(message)` | 输出带插件名称标记的日志 |

```js
const unsubscribe = on("request.end", (event) => {
  log(`${event.model ?? "unknown"}: ${event.durationMs} ms`)
})

// 不再需要订阅时：
unsubscribe()
```

## 七类事件

| 事件 | 触发时机 | 主要数据 |
| --- | --- | --- |
| `request.start` | 鉴权通过后、读取请求体前 | 公共请求字段，`model` 初始为 `null` |
| `request.model` | handler 已解析出请求模型后 | 公共请求字段，`model` 为映射前的原始请求模型 |
| `request.actual_model` | 网关准备调用上游，确定或切换实际目标模型时 | 公共字段，带 `actualModel` |
| `request.session` | 请求进行中，现有会话解析逻辑确定或更新会话时 | 公共请求字段，带已确定的 `sessionId` |
| `request.first_token` | 现有流解析逻辑观察到思考开始或首个非空模型输出时 | 公共字段，加 `firstTokenMs` |
| `request.end` | 响应体结束、出错、被取消，或客户端中断时 | 公共字段，加 `durationMs`、`firstTokenMs`、`status`、`outcome` |
| `usage.recorded` | 现有用量记录逻辑生成有效用量事件时 | 现有用量字段，加 `requestId`、`userAgent`、`sessionId` 和 `actualModel` |

公共请求字段：

```ts
{
  id: string           // 网关生成的请求 ID
  traceId: string      // 现有 trace ID
  userAgent: string    // 复用请求上下文中的 User-Agent，未提供时为空字符串
  sessionId: string | null // 复用现有会话解析结果，未知时为 null
  path: string         // 请求路径
  port: number         // 配置的监听端口
  startedAt: number    // Unix 时间戳，毫秒
  model: string | null // 原始请求模型，尚未获取时为 null
  actualModel: string | null // 映射和选模后的上游目标，尚未确定时为 null
}
```

`request.end` 额外提供：

```ts
{
  durationMs: number
  firstTokenMs: number | null
  status: number
  outcome: "completed" | "error" | "cancelled"
}
```

`durationMs` 从鉴权后的请求开始计时，持续到响应体结束，包含读取请求体、解压和生成过程。持续时间采用单调时钟，单位为毫秒。响应头返回前中断时，`status` 为 `0`。

`model` 保留原始请求模型，`actualModel` 记录模型映射、provider 别名解析、自动选模和端点模型归一化之后，实际发给上游的目标模型（Google 取模型 URL 中的 ID）。例如请求 `my-alias` 最终调用 `gpt-5.4`，事件中分别为 `model: "my-alias"`、`actualModel: "gpt-5.4"`。

`actualModel` 在开始时为 `null`；确定上游目标时立即触发 `request.actual_model`，不需要等模型响应或 usage，运行中以及失败但没有用量的请求也能获取。未知目标或无法获取模型的原始透传路由保持 `null`。同一请求先后切换模型时会再次触发该事件，后续生命周期事件带最新目标；上游服务内部的二次选模无法确认。插件可这样订阅：

```js
on("request.actual_model", (event) => {
  log(`${event.model ?? "unknown"} -> ${event.actualModel}`)
})
```

`firstTokenMs` 表示首次观察到思考开始或模型输出的耗时（TTFT），与 `durationMs` 一样从鉴权后的请求开始计时，包含上传、解压和等待上游的时间。思考开始就计入，不需要等思考文本：Anthropic 的 `content_block_start`（`type: "thinking"`）、Responses 的 `response.output_item.added`（reasoning item）及 `response.reasoning_summary_part.added`、Google 的 `thought: true` part 都会触发。

非空文本、公开推理、工具参数或输入增量，以及已有内容的 Anthropic 初始块、Google 文本和完整函数调用仍会计入；空白字符也属于有效输出。心跳、角色声明、空增量、签名、用量和通用响应/工具开始元数据不会触发。

`request.first_token` 每个请求只触发一次，不向插件传递输出内容，也不重复读取或解析流。隐藏思考只要有开始标记就可以计时；如果上游既不发思考标记，也不发内容，则无法观察到内部开始时间，仍需等待首个符合条件的事件。记录的是网关收到该事件的时间，不是模型内部的时间戳。非流式响应、由完整结果合成的流、原始透传路由，以及结束前没有思考标记或有效输出的流，`firstTokenMs` 为 `null`。监控示例将该值写入 `ttft_ms`。

`sessionId` 使用现有用量统计的解析顺序：请求上下文的 session affinity 优先，其次使用 handler 原先选出的显式或 fallback session。头部已有的会话在 `request.start` 中提供；需要解析 payload 或 handler fallback 才能确定的，在创建原有用量 recorder 时通过 `request.session` 补充，因此不需要等模型返回 token 才知道会话。未知时为 `null`；插件系统不额外生成会话 ID。

用 `request.end.id` 与 `usage.recorded.requestId` 关联两类事件。所有请求生命周期事件和用量事件都带 `userAgent`、`sessionId`。用量事件保留原来的 `model`、`trace_id`、`session_id`、token 和费用等字段；额外的 `sessionId` 与原有 `session_id` 对应，原值为空时为 `null`；`actualModel` 对应该条用量原有的 `model`，不取请求后来切换到的目标。这些模型和会话别名是插件事件的额外元数据，不新增对应的 SQLite 字段。SQLite 和用量事件接口另行保存/返回 `user_agent`，截取传入 User-Agent 的前 64 个字符；插件原有的 `userAgent` 元数据保留原值。SQLite 另行保存请求计时，与插件是否启用无关，见[请求计时](usage.md#request-timing)。原有 token、费用和 session 统计方式不变。没有有效用量时仍然不产生用量事件。用量可能在响应清理期间或之后到达，不保证总在 `request.end` 之前；请求结束后才出现的用量会话以该用量事件为准。

## 完整监控插件示例

仓库中的 [monitor.mjs](../../../plugin/gateway/monitor.mjs) 可以实现两个 PR 对应的文件输出：

- `inflight-<port>-<pid>.json`：当前运行中的请求，包含开始时间和模型。
- `timings-YYYY-MM.jsonl`：请求总耗时、首 token 延迟、HTTP 状态和结束原因。

将这个文件保存到 `D:/copilot-plugins/monitor.mjs`，然后在开发分支仓库根目录运行：

```powershell
$env:COPILOT_API_PLUGINS = '["D:/copilot-plugins/monitor.mjs"]'
$env:COPILOT_API_MONITOR_DIR = 'D:/copilot-monitor'
bun run start start --port 5000
```

运行中快照示例：

```json
{
  "pid": 1234,
  "port": "5000",
  "updated": 1792780000,
  "requests": {
    "request-uuid": { "t": 1792780000, "model": "my-alias", "actual_model": "gpt-5.4", "user_agent": "client/1.0", "session_id": "existing-session", "ttft_ms": null }
  }
}
```

耗时日志每行示例：

```json
{"t":1792780000,"port":"5000","model":"my-alias","actual_model":"gpt-5.4","user_agent":"client/1.0","session_id":"existing-session","ms":1234,"ttft_ms":456,"status":200,"outcome":"completed"}
```

文件输出的 `t` 和 `updated` 使用秒，与事件接口的毫秒时间戳区分。快照通过临时文件加 rename 替换，正常退出时删除；异常退出后的读取方应检查 PID 是否存活。运行中的请求不按 15 分钟过期。

示例会合并短时间内的快照变更，并使用异步文件写入，因此文件 I/O 不会阻塞请求处理。快照写入期间的变更会合并到下一份最新状态快照，写入失败后自动重试，指数退避间隔上限为 5 秒。退出时取消待执行的写入和重试，等待当前写入结束后删除快照及临时文件；清理仍受插件运行时的退出超时限制。

## 当前版本的范围

- 覆盖现有 POST Chat Completions、Messages、Responses 和 alpha search 路由，包括对应的 `/v1` 与 provider 路径。鉴权失败、模型发现和 token 计数接口不产生这些生命周期事件。
- 模型事件复用现有解析结果，zstd 请求在已有解压流程后获取模型。完全透传且不解析正文的 alpha search 请求可能始终为 `model: null`。
- 同一插件内的事件按顺序执行；异步钩子不会被请求链路等待。每个插件最多积压 1024 次 handler 调用，满后会丢弃新事件并记录警告，因此这是尽力投递的监控接口，没有持久队列或自动重放。
- 退出时最多等待 2 秒，用于排空队列和执行清理函数。
- 同步代码仍与网关共享事件循环，插件中的同步耗时操作会阻塞网关。插件作为受信任的本地代码运行，没有沙箱。
- 不配置 `COPILOT_API_PLUGINS` 时不加载用户插件、不发送插件事件。共享响应包装仍用于 SQLite 请求计时，复用单个透传 reader，不重复解析流。核心本身不写上述插件监控文件。
