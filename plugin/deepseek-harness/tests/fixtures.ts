/** Local HTTP gateway exercising the real pi-ai protocol implementations. */
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
type Protocol = 'openai-responses' | 'anthropic-messages'

export const MODEL_ID = 'codex/gpt-gateway'
export const MODEL_LIST = { data: [{
  id: MODEL_ID, display_name: 'Gateway Model', context_window: 128000, max_output_tokens: 16000,
  input_modalities: ['text', 'image'], reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
}, { id: 'provider/text-only' }] }

export interface WireRequest {
  path: string
  method: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

export function frames(protocol: Protocol, tool = false): Record<string, unknown>[] {
  if (protocol === 'anthropic-messages') {
    return [
      { type: 'message_start', message: {
        id: 'msg_gateway', type: 'message', role: 'assistant', model: MODEL_ID, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 1 },
      } },
      { type: 'content_block_start', index: 0, content_block: tool
        ? { type: 'tool_use', id: 'call_gateway', name: 'lookup', input: {} }
        : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: '{"key":1}' }
        : { type: 'text_delta', text: 'hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
  }
  const item = tool
    ? { type: 'function_call', id: 'fc_gateway', call_id: 'call_gateway', name: 'lookup', arguments: '{"key":1}' }
    : { type: 'message', id: 'msg_gateway', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
  return [
    { type: 'response.created', response: { id: 'resp_gateway' } },
    { type: 'response.output_item.added', output_index: 0, item: tool
      ? { ...item, arguments: '' } : { ...item, content: [] } },
    ...tool ? [
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"key":1}' },
    ] : [
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    ],
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id: 'resp_gateway', status: 'completed', output: [item],
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
    } },
  ]
}

export interface Gateway {
  url: string
  requests: WireRequest[]
  models: unknown
  modelStatus: number
  inferenceStatus: number
  failNext: number
  tool: boolean
  hold: boolean
  closed: number
  dispose(): Promise<void>
}

export async function gateway(protocol: Protocol): Promise<Gateway> {
  let server: Server
  const state: Gateway = {
    url: '', requests: [], models: structuredClone(MODEL_LIST), modelStatus: 200, inferenceStatus: 200,
    failNext: 0, tool: false, hold: false, closed: 0,
    dispose: () => new Promise(resolve => { server.close(() => { resolve() }); server.closeAllConnections() }),
  }
  server = createServer((request, response) => {
    const data: Buffer[] = []
    request.on('data', (chunk: Buffer) => { data.push(chunk) })
    request.on('end', () => {
      state.requests.push({
        path: request.url ?? '', method: request.method ?? '', headers: request.headers,
        body: data.length === 0 ? {} : JSON.parse(Buffer.concat(data).toString('utf8')) as Record<string, unknown>,
      })
      response.on('close', () => { state.closed++ })
      if (request.method === 'GET') {
        response.writeHead(state.modelStatus, { 'content-type': 'application/json' })
        response.end(JSON.stringify(state.models))
        return
      }
      const status = state.failNext > 0 ? (state.failNext--, 503) : state.inferenceStatus
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' })
        response.end('{"error":{"message":"temporary gateway failure","type":"overloaded_error"}}')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const events = frames(protocol, state.tool)
      for (const event of state.hold ? events.slice(0, 1) : events) {
        response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      if (!state.hold) response.end()
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test gateway did not bind TCP')
  state.url = `http://127.0.0.1:${address.port}/gateway/v1`
  return state
}
