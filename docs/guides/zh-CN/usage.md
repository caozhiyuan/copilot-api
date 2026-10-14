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
   - 如果你在 Windows 上使用 `start.bat` 脚本，这个页面会自动打开。

看板提供了更易读的 Copilot 用量视图：

> token usage 历史记录需要 Bun 或 Node.js >= 22.13.0。更早的 Node.js 上服务会正常运行，但 token usage 存储会被禁用。

- **API Endpoint URL**：通过 URL 查询参数指定 API endpoints，默认指向本地服务。支持手动切换为其他兼容 endpoints。
- **API Key 认证**：如果启用了 API Key 认证，可填入原始 API key（默认通过 `x-api-key` 请求头发送）或 `Authorization: Bearer <key>`。凭据会按 endpoint origin 保存在浏览器本地存储中；切换到不同 endpoint origin 时，不会自动携带其他 origin 的凭据。
- **Period 选择器**：支持六种时间范围：`today`（当前本地日历日至今）、`this_week`（本周一 00:00 至现在）、`last_7_days`（滚动 7 个日历日至现在）、`this_month`（本月 1 日 00:00 至现在）、`last_30_days`（滚动 30 个日历日至现在）和 `lifetime`（从最早记录事件至现在）。默认选择 Today，选择器旁会显示具体日期范围；切换时 URL 参数会自动同步，方便收藏和分享。旧版取值 `day`、`week`、`month` 仍被兼容，会自动映射到对应的新值。
- **Fetch Data**：点击 "Refresh" 按钮加载或刷新使用数据。页面加载时也会自动拉取数据。
- **Copilot Quotas 额度**：通过进度条展示 Chat、Completions 等不同服务的额度使用情况，悬停可查看已用/剩余详情。
- **Token Usage 指标卡片**：汇总当前周期的 Total、Input、Output、Cache Read、Cache Write、Requests 和预估费用。
- **趋势图**：提供按所选周期、模型和指标筛选的折线趋势图，点击数据点可查看用量明细；Lifetime 图表数据从每日数据桶中采样，最多显示 180 个点，以便查看长期趋势。
- **Model Breakdown 表格**：按模型维度列出周期内的请求数、输入/输出/缓存 token 和预计费用。
- **Request Events 分页列表**：按时间排序的请求事件记录，支持分页浏览，含时间戳、模型、请求 ID 和 token 用量。
- **Detailed Information**：展示 API 返回的完整 JSON 响应，便于深入分析所有可用统计数据。
- **URL-based Configuration**：也可通过 `endpoint` 和 `period` 查询参数直接指定 API 端点与时间范围。例如：
  `http://localhost:4141/usage-viewer?endpoint=http://your-api-server/usage&period=this_week`

### Usage Viewer 截图

<p align="center">
  <img src="../../screenshots/usage-viewer.png" alt="Copilot API Usage Viewer 页面" width="900" />
</p>
