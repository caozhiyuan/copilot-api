# Gateway event plugins

Plugins are local `.mjs` files that observe request state and usage through events.
The gateway provides common events; plugins can write JSONL logs and in-flight
snapshots or integrate with other monitoring systems. Model information reuses
the payload already parsed by the handler. Events do not include request bodies,
response content, or authentication headers.

These plugins run on the gateway server, separately from the Claude Code and
OpenCode client integrations.

## Minimal example

Create `simple-monitor.mjs`:

```js
export default function setup({ version, server, on, log }) {
  log(`Plugin API v${version}, listening on port ${server.port}`)

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
    log("Plugin stopped")
  }
}
```

Set the plugin path, then start the gateway. Windows PowerShell:

```powershell
$env:COPILOT_API_PLUGINS = '["D:/copilot-plugins/simple-monitor.mjs"]'
copilot-api start --port 5000
```

macOS / Linux:

```sh
export COPILOT_API_PLUGINS='["/absolute/path/simple-monitor.mjs"]'
copilot-api start --port 5000
```

These commands use the `copilot-api` CLI. To run from source, replace the startup
command with `bun run start start --port 5000` from the repository root.

`COPILOT_API_PLUGINS` is a JSON array and can contain multiple plugins. Absolute
paths are used directly. Relative paths resolve under the API home directory,
`COPILOT_API_HOME`, or the existing application data directory when it is unset,
rather than the terminal's working directory. Restart the server after changing
the plugin list or code. A value that is not a valid JSON array of paths causes a
startup error. An individual plugin import or setup failure is logged, and that
plugin is skipped.

Node.js and Bun use the same `.mjs` format; plugins do not need an npm package.

## Plugin API

The default-exported setup function may be async and may return a synchronous or
asynchronous shutdown cleanup function.

| Parameter | Meaning |
| --- | --- |
| `version` | Plugin API version, currently `1` |
| `server.pid` | Gateway process PID |
| `server.port` | Configured listening port, not inferred from the client's Host header |
| `on(name, handler)` | Subscribe to an event and return an unsubscribe function; the handler may return a Promise |
| `log(message)` | Write a log message tagged with the plugin name |

```js
const unsubscribe = on("request.end", (event) => {
  log(`${event.model ?? "unknown"}: ${event.durationMs} ms`)
})

// When the subscription is no longer needed:
unsubscribe()
```

Handlers receive immutable event snapshots. Handler errors are logged without
rejecting the request.

## Seven event types

| Event | When | Main data |
| --- | --- | --- |
| `request.start` | After authentication, before reading the body | Common request fields, initially `model: null` |
| `request.model` | A handler has parsed the requested model | Common request fields with the original requested model, before mapping |
| `request.actual_model` | Upstream dispatch selects or changes the resolved target | Common fields with `actualModel` |
| `request.session` | Existing session resolution identifies or updates the session while the request is active | Common request fields with the resolved `sessionId` |
| `request.first_token` | Existing stream parsing observes thinking start or the first nonempty model output | Common fields plus `firstTokenMs` |
| `request.end` | The response body completes, errors, is cancelled, or the client aborts | Common fields plus `durationMs`, `firstTokenMs`, `status`, and `outcome` |
| `usage.recorded` | The existing usage recorder produces a valid usage event | Existing usage fields plus `requestId`, `userAgent`, `sessionId`, and `actualModel` |

Common request fields:

```ts
{
  id: string           // Gateway-generated request ID
  traceId: string      // Existing trace ID
  userAgent: string    // User-Agent from the request context, or an empty string if absent
  sessionId: string | null // Existing resolved session, or null if unknown
  path: string         // Request path
  port: number         // Configured listening port
  startedAt: number    // Unix timestamp in milliseconds
  model: string | null // Original requested model, or null until known
  actualModel: string | null // Upstream target after mapping and selection, or null until known
}
```

`request.end` also provides:

```ts
{
  durationMs: number
  firstTokenMs: number | null
  status: number
  outcome: "completed" | "error" | "cancelled"
}
```

`id` is generated by the gateway, independently of client-supplied trace IDs.
`port` is the configured listening port, not inferred from the client's Host header.

`durationMs` runs from the post-authentication request start until the response
body ends, including body upload, decompression, and generation. Durations use a
monotonic clock and are measured in milliseconds. A cancellation before response
headers has `status` set to `0`.

`model` stays the original client-requested model. `actualModel` is the target
sent upstream after model mapping, provider alias resolution, automatic model
selection, and endpoint normalization. For Google, it is the model ID in the
request URL. Targets include the configured provider name, such as
`codex/gpt-5.4`, `xai/grok-4`, or `my-provider/claude-sonnet-4.6`.
GitHub Copilot targets keep the model ID without a provider prefix. For example,
a request for `my-alias` routed to Codex produces `model: "my-alias"` and
`actualModel: "codex/gpt-5.4"`. The same prefix rule applies to `usage.recorded`;
persisted usage model fields keep their existing format.

`actualModel` starts as `null`. Once the upstream target is known, the gateway
immediately emits `request.actual_model`, without waiting for a model response or
usage. It is therefore available for in-flight requests and failed requests
without usage. Unknown targets and raw passthrough routes whose model cannot be
determined keep it `null`. If the same request changes targets, the event repeats;
subsequent lifecycle events carry the latest target. Provider-internal model
selection cannot be confirmed. A plugin can subscribe as follows:

```js
on("request.actual_model", (event) => {
  log(`${event.model ?? "unknown"} -> ${event.actualModel}`)
})
```

`firstTokenMs` measures time to the first observable thinking start or model output
(TTFT), from the same post-authentication request start as `durationMs`. It includes
upload, decompression, and upstream wait time. Thinking start counts without
waiting for thinking text: Anthropic `content_block_start` with `type: "thinking"`,
Responses `response.output_item.added` with a reasoning item and
`response.reasoning_summary_part.added`, and Google parts with `thought: true`
all trigger the event.

Nonempty text, exposed reasoning, tool argument or input deltas, initial Anthropic
blocks with content, Google text parts, and complete Google function calls also
count. Whitespace counts as output. Heartbeats, role declarations, empty deltas,
signatures, usage, and generic response/tool-start metadata do not trigger it.

`request.first_token` is emitted once per request, without forwarding output
content to plugins or reading or parsing the stream again. Hidden thinking can be
timed if a start marker is available. If the upstream emits neither a thinking
marker nor content, the gateway cannot observe its internal start time and waits
for the first eligible event. This records the event's arrival time at the
gateway, not an internal model timestamp. Non-streaming responses, synthetic
streams built from complete results, raw passthrough routes, and streams that end
without a thinking marker or eligible output have `firstTokenMs` set to `null`. The
monitoring example writes this value as `ttft_ms`.

`sessionId` uses the existing usage accounting resolution order: request-context
session affinity first, then the explicit or fallback session already selected
by the handler. Header-derived sessions are available in `request.start`.
Sessions that require payload parsing or a handler fallback are supplied through
`request.session` when the existing usage recorder is created, before the model
returns tokens. Unknown sessions are `null`; the plugin system does not generate
new session IDs.

Join `request.end.id` with `usage.recorded.requestId`. All request lifecycle and
usage events include `userAgent` and `sessionId`. Usage events retain existing
`model`, `trace_id`, `session_id`, token, and cost fields. The additional
`sessionId` mirrors the existing `session_id`, with an empty value becoming
`null`. `actualModel` aliases that usage event's existing `model`, rather than a
target selected later in the request. These model and session aliases are extra
plugin metadata and do not add corresponding SQLite columns. SQLite and the
usage events API separately store/return `user_agent`, truncated to the first
64 characters; the plugin's `userAgent` metadata retains the original value.
SQLite also stores request timing independently of plugin activation; see
[request timing](usage.md#request-timing). Existing token, cost, and session
accounting stays unchanged. No usage event is emitted without valid usage. Usage
may arrive during or after response cleanup and is not guaranteed to precede
`request.end`. For usage that arrives after the request ends, use the session in
that usage event.

## Complete monitoring plugin example

The repository's [monitor.mjs](../../../plugin/gateway/monitor.mjs) writes these
files:

- `inflight-<port>-<pid>.json`: currently active requests, including start times and models.
- `timings-YYYY-MM.jsonl`: request duration, first-token latency, HTTP status, and outcome.

Save this file to `D:/copilot-plugins/monitor.mjs`, set the output directory, then
start the gateway:

```powershell
$env:COPILOT_API_PLUGINS = '["D:/copilot-plugins/monitor.mjs"]'
$env:COPILOT_API_MONITOR_DIR = 'D:/copilot-monitor'
copilot-api start --port 5000
```

Example in-flight snapshot:

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

Example timing log line:

```json
{"t":1792780000,"port":"5000","model":"my-alias","actual_model":"gpt-5.4","user_agent":"client/1.0","session_id":"existing-session","ms":1234,"ttft_ms":456,"status":200,"outcome":"completed"}
```

The file output's `t` and `updated` use seconds, unlike the event API's millisecond
timestamps. Snapshots are replaced through a temporary file and rename, then
removed on normal shutdown. After a crash, readers should check whether the PID
is still alive. Active requests do not expire after 15 minutes.

The example batches snapshot changes and uses asynchronous file writes, so file
I/O does not block request handling. Changes during a snapshot write are coalesced
into the next snapshot of the latest state. Failed writes retry automatically
with exponential backoff capped at five seconds. Shutdown cancels scheduled
writes and retries, waits for the active write, then removes the snapshot and
temporary file. Cleanup remains subject to the plugin runtime's shutdown deadline.

## Current scope

- Covers existing POST Chat Completions, Messages, Responses, and alpha search routes, including their `/v1` and provider-scoped paths. Authentication failures, model discovery, and token-count endpoints do not produce these lifecycle events.
- Image generation/editing and video endpoints do not publish plugin lifecycle or usage events. Image usage, costs, and request timing continue to be stored in SQLite.
- Model events reuse existing parsed payloads, after the existing decompression step for zstd requests. Fully passthrough alpha search requests that do not parse the body may keep `model: null` throughout.
- Events within each plugin run in order; requests do not wait for async hooks. Each plugin can queue at most 1024 handler invocations, then drops new events with a warning. Delivery is best effort, without a durable queue or automatic replay.
- Shutdown waits at most two seconds to drain queues and run cleanup functions.
- Synchronous code shares the gateway event loop, so slow synchronous plugin work blocks the gateway. Plugins run as trusted local code without a sandbox.
- With `COPILOT_API_PLUGINS` unset, no user plugins are loaded and no plugin events are sent. The shared response wrapper still measures SQLite request timing, reusing a single pull-through reader without parsing the stream again. The gateway itself does not write the plugin monitoring files above.
