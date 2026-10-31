# 用量监控

[项目首页](../../../README.zh-CN.md) · [文档目录](README.md) · [English](../en/usage.md)

<a id="using-the-usage-viewer"></a>

## 使用量查看器

服务启动后，控制台会输出一个 Copilot 使用量看板 URL。这个看板是一个用于监控 API 用量的 Web 界面。

1. 启动服务。例如使用 Bun（推荐）：
   ```sh
   bunx --bun @jeffreycao/copilot-api start
   ```
2. 服务会输出一个 usage viewer 的 URL。将它复制到浏览器中打开，形式大致如下：
   `http://localhost:4141/usage-viewer?endpoint=http://localhost:4141/usage`

看板提供了更易读的 Copilot 用量视图：

> token usage 历史记录需要 Bun 或 Node.js >= 22.13.0。更早的 Node.js 上服务会正常运行，但 token usage 存储会被禁用。

- **API Endpoint URL**：通过 URL 查询参数指定 API endpoints，默认指向本地服务。支持手动切换为其他兼容 endpoints。
- **API Key 认证**：如果启用了 API Key 认证，可填入原始 API key（默认通过 `x-api-key` 请求头发送）或 `Authorization: Bearer <key>`。凭据会按 endpoint origin 保存在浏览器本地存储中；切换到不同 endpoint origin 时，不会自动携带其他 origin 的凭据。
- **Period 选择器**：支持六种时间范围：`today`（当前本地日历日至今）、`this_week`（本周一 00:00 至现在）、`last_7_days`（滚动 7 个日历日至现在）、`this_month`（本月 1 日 00:00 至现在）、`last_30_days`（滚动 30 个日历日至现在）和 `lifetime`（从最早记录事件至现在）。默认选择 Today，选择器旁会显示具体日期范围；切换时 URL 参数会自动同步，方便收藏和分享。旧版取值 `day`、`week`、`month` 仍被兼容，会自动映射到对应的新值。
- **Fetch Data**：点击 "Refresh" 按钮加载或刷新使用数据。页面加载时也会自动拉取数据。
- **订阅额度标签页**：集中查看 Copilot、Codex、xAI 和 OpenCode Go 的额度卡片，包含 models.dev 标识、剩余额度、余额及本地重置时间。打开此标签页时按需加载，支持单独刷新和全部刷新，并兼容 Codex Business 工作区 Credits、成员上限及 OpenCode Go 的滚动 5 小时 / 每周 / 每月额度。可用 `&tab=subscriptions` 收藏此标签页。
- **Token Usage 指标卡片**：汇总当前周期的 Total、Input、Output、Cache Read、Cache Write、Requests 和预估费用。
- **趋势图**：提供按所选周期、模型和指标筛选的折线趋势图，点击数据点可查看用量明细；Lifetime 图表数据从每日数据桶中采样，最多显示 180 个点，以便查看长期趋势。
- **Model Breakdown 表格**：按模型维度列出周期内的请求数、输入/输出/缓存 token 和预计费用。
- **Request Events 分页列表**：按时间排序的请求事件记录，支持分页浏览，含时间戳、模型、请求 ID 和 token 用量。
- **URL-based Configuration**：也可通过 `endpoint` 和 `period` 查询参数直接指定 API 端点与时间范围。例如：
  `http://localhost:4141/usage-viewer?endpoint=http://your-api-server/usage&period=this_week`

### 图片用量与费用

图片生成和编辑也会进入 Token Usage 的事件、模型、日期和 session 汇总，记录实际转发的模型。Codex 请求省略 `model` 时，按其默认模型 `gpt-image-2` 记录和估价。Codex 保存上游报告的输入、输出和总 token，使用图片/文本 token 明细按内置的 OpenAI 官方 API 单价估算美元费用，内置计价仅支持 GPT Image 2 和 2.5（含版本名和日期快照）；这是 API 价格参考值，不代表 Codex 订阅额外扣费。未返回明细时，输入按文本、输出按图片估算；其他模型保留 token，不猜测价格。

xAI 使用上游 `usage.cost_in_usd_ticks` 报告的费用（`10^10` ticks = 1 USD），不内置图片价格。只返回费用时仍计入请求数和费用汇总，token 显示为 0，表示上游未报告 token。没有有效 token 或有效费用的响应不新增记录。

开启 verbose 日志后，图片响应记录 JSON 中除 `data` 外的元数据，流式图片 base64 也会省略；编辑请求记录 prompt、模型和其他参数，图片 base64 使用占位标记，multipart 文件仅记录名称、类型和大小。

图片请求也记录请求 ID、总耗时、完成/取消状态，并触发插件生命周期事件；图片首 token 延迟仍为空。JSON 的 `model` 位于前部时直接流式转发，模型改写也按块处理；模型位于后部及 xAI 格式转换时，大请求体/字符串使用临时文件暂存，暂存请求上限为 512 MiB，使用后自动清理。verbose JSON 日志在转发过程中提取元数据，不完整缓存请求体。

### 视频费用

查询 xAI 视频任务返回 `status: "done"` 且包含有效 `usage.cost_in_usd_ticks` 时，费用会写入 SQLite 的 `token_usage_events`，端点标记为 `videos_generations`，并进入事件、模型、日期和 session 汇总。换算规则为 `10^10` ticks = 1 USD，例如 `11300000000` ticks 记录为 1.13 USD；上游未报告 token 时，各 token 字段为 0。

SQLite 按 provider、端点和上游任务 ID 去重，同一任务重复查询或重启后查询都只记录一次。未完成、失败或缺少有效费用的任务不新增费用记录。开启 `--verbose` 后，查询响应的完整 body 写入 `videos-handler-YYYY-MM-DD.log` 中的 `videos.result.response.body`。

### Usage Viewer 截图

<p align="center">
  <img src="../../screenshots/usage-viewer.png" alt="Copilot API Usage Viewer 页面" width="900" />
</p>

<a id="request-timing"></a>

### 请求计时

Desktop 的 **Token 使用 → 模型明细** 和 Web 的 **Model Breakdown** 在 Total Tokens 前展示所选周期的平均首 token 延迟和输出速度。Request Events 也在 Total Tokens 前展示请求总耗时。历史记录等缺失数据展示 `—`。

首 token 延迟从鉴权后、读取请求体和解压前开始计时，首次观察到思考开始标记或有效输出时结束。思考开始就计入，不需要暴露思考文本。总耗时持续到响应体结束，二者都采用单调时钟。计时复用已经解析的流事件，不需要启用 `COPILOT_API_PLUGINS`。

已有 SQLite 用量库会自动增加四个可空计时字段：`request_id`、`first_token_ms`、`duration_ms`、`request_outcome`。另增加 `user_agent TEXT NOT NULL DEFAULT ''`，保存传入 User-Agent 的前 64 个字符，与插件或计时是否启用无关；缺失请求头和历史记录使用空字符串。请求 ID 为每次 HTTP 请求单独生成，不使用调用方可能重复传入的 trace ID。原有 token、费用、session 统计方式不变，没有有效用量的请求不新增记录。用量到达时照常保存，响应结束后补齐计时；结束后才到达的用量直接携带完整计时。通过现有刷新操作查看完成后的数据，历史记录不回填。

```text
输出速度（tok/s）= output_tokens / ((duration_ms - first_token_ms) / 1000)
```

这是请求侧的估算值，token 数采用上游报告的输出用量，思考 token 是否计入取决于上游口径。耗时包含观察到思考开始后的思考、传输和客户端读取等待。`request_outcome` 描述 HTTP/响应体完成情况；SSE error 事件仍可能正常结束并记为 `completed`，因此它不表示模型一定成功。

- 单条事件的速度要求请求正常完成、只有一条 usage、输出 token 数大于零且生成耗时大于零。非流式、完整结果合成的流、原始透传和无法观察首 token 的请求保持空值。取消、传输错误和未结束的请求不计算速度。
- 模型平均首 token 延迟按有效的完整请求计算，每个请求计一次。模型速度为有效输出 token 总数除以对应生成耗时之和。同一请求的多条同模型 usage 合并输出量，耗时只计一次；单条事件无法分摊总耗时，因此其速度为空。
- 同一请求切换过多个模型时，不纳入模型性能统计，token 和费用总量照常统计。usage 跨越所选周期或日边界的请求不纳入对应桶的计时，避免将部分用量除以完整耗时。零输出或生成耗时为零的有效请求仍可参与平均首 token 统计，但不参与速度统计。缺失值不按零处理。

`/token-usage/events` 返回上述四个计时字段、`user_agent` 及可空的 `output_tokens_per_second`。`/token-usage` 和 `/token-usage/daily` 的模型条目（含每日模型数据）返回可空的 `average_first_token_ms` 和 `output_tokens_per_second`。沿用现有 usage 的模型字段聚合，即计费统计所用的实际上游目标模型。
