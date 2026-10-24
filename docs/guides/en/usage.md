# Usage Monitoring

[Home](../../../README.md) · [Documentation](README.md) · [简体中文](../zh-CN/usage.md)

## Using the Usage Viewer

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1.  Start the server. For example, using Bun (recommended):
    ```sh
    bunx --bun @jeffreycao/copilot-api start
    ```
2.  The server will output a URL to the usage viewer. Copy and paste this URL into your browser. It will look something like this:
    `http://localhost:4141/usage-viewer?endpoint=http://localhost:4141/usage`
    - If you use the `start.bat` script on Windows, this page will open automatically.

The dashboard provides a user-friendly interface to view your Copilot usage data:

> Token usage history requires Bun or Node.js >= 22.13.0. On older Node.js versions the server runs normally but token usage storage is disabled.

- **API Endpoint URL**: The dashboard is pre-configured to fetch data from your local server endpoint via a URL query parameter. You can manually switch this to any other compatible API endpoint.
- **API Key Authentication**: If API Key authentication is enabled, enter a raw API key (sent as the `x-api-key` header) or `Authorization: Bearer <key>`. Credentials are remembered in the browser's local storage per endpoint origin, and switching to a different endpoint origin does not automatically send the previous credential.
- **Period Selector**: Choose from six time ranges: `today` (the current local calendar day so far), `this_week` (Monday at 00:00 through now), `last_7_days` (the rolling seven calendar days through now), `this_month` (the first day of the current month at 00:00 through now), `last_30_days` (the rolling 30 calendar days through now), and `lifetime` (the earliest recorded event through now). Today is selected by default, and the exact date range appears next to the selector. The URL query parameter updates automatically when you switch, making it easy to bookmark and share. The legacy values `day`, `week`, and `month` are still accepted and mapped to their new equivalents.
- **Fetch Data**: Click the "Refresh" button to load or refresh the usage data. The dashboard also fetches data automatically on page load.
- **Copilot Quotas**: View quota usage for services such as Chat and Completions via progress bars. Hover over a card to see used/remaining details.
- **Token Usage Metric Cards**: See a summary of Total, Input, Output, Cache Read, Cache Write, Requests, and estimated cost for the current period.
- **Trend Chart**: An interactive line chart with model and metric filters for the selected period. Click a data point to inspect the usage breakdown for a day; Lifetime chart data is sampled from the daily buckets and capped at 180 points for readability.
- **Model Breakdown Table**: A per-model summary of requests, input/output/cache tokens, and estimated cost for the selected period.
- **Request Events (Paginated)**: A time-sorted list of request event records with pagination support, showing timestamps, models, request IDs, and token counts.
- **Detailed Information**: See the full JSON response from the API for a detailed breakdown of all available usage statistics.
- **URL-based Configuration**: You can also specify the API endpoint and period directly via `endpoint` and `period` query parameters. For example:
  `http://localhost:4141/usage-viewer?endpoint=http://your-api-server/usage&period=this_week`

### Usage Viewer Screenshot

<p align="center">
  <img src="../../screenshots/usage-viewer.png" alt="Copilot API usage viewer" width="900" />
</p>

<a id="request-timing"></a>

### Request timing

Desktop **Token usage → Model breakdown** and Web **Model Breakdown** display
average TTFT and output speed immediately before Total Tokens for the selected
period. Request Events display total duration immediately before Total Tokens. Missing
measurements, including historical rows, display `—`.

TTFT starts after authentication, before upload/decompression, and ends on the
first observable thinking-start marker or eligible output. Thinking starts count
without exposed reasoning text. Total duration ends when the response body
finishes. Both use a monotonic clock. Timing reuses the already-parsed stream
and works without `COPILOT_API_PLUGINS`.

SQLite automatically adds nullable `request_id`, `first_token_ms`, `duration_ms`,
and `request_outcome` columns to existing usage databases. It also adds
`user_agent TEXT NOT NULL DEFAULT ''`: each usage row stores the first 64
characters of the incoming User-Agent, independently of plugin/timing activation.
Missing headers and historical rows have an empty string. Request IDs are generated
per HTTP request, independently of caller-supplied/reused trace IDs. Token, cost,
and session accounting stay unchanged; zero-usage requests do not create rows.
Usage is saved as soon as it arrives, then timing is completed when the response
ends. Usage arriving after completion carries the final timing directly. Refresh
the existing viewer to see completed timing; old rows are not backfilled.

```text
output_tokens_per_second = output_tokens / ((duration_ms - first_token_ms) / 1000)
```

This is a request-side estimate using upstream-reported output tokens, including
whatever reasoning tokens the upstream counts. It includes thinking after the
observed start, delivery, and client backpressure. `request_outcome` describes
HTTP/body completion: an SSE protocol error may still close normally and be
classified as `completed`; it does not certify model success.

- Per-event speed requires a completed request with exactly one usage row,
  positive output tokens, and positive generation duration. Non-streaming,
  synthetic-from-complete-result, raw passthrough, and unobservable streams have
  null TTFT/speed. Cancelled, errored, and unfinished requests have null speed.
- Model average TTFT counts each valid completed request once. Model speed is
  the sum of eligible output tokens divided by the sum of their generation
  durations, rather than an average of individual rates. A request with multiple
  same-model usage rows contributes its combined output and duration once;
  per-event speeds remain null because time cannot be attributed to one row.
- Mixed-model requests are excluded from model timing; their token/cost totals
  remain included. Requests with usage spanning a period/day boundary are also
  excluded from that bucket's timing to avoid using partial usage with a full
  duration. Zero-output or zero-generation-duration samples can contribute TTFT
  but do not contribute to speed. Missing timing never counts as zero.

`/token-usage/events` exposes the four timing fields, `user_agent`, and nullable
`output_tokens_per_second`. Model entries in `/token-usage` and
`/token-usage/daily` expose nullable `average_first_token_ms` and
`output_tokens_per_second`, including daily model buckets. Aggregation is by the
existing usage model (the resolved upstream target used for accounting).
