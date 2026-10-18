/** Real HTTP/SSE calls cover discovery, selector metadata, transport, replay, and cancellation. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createToolResultMessage, createUserMessage, ReasoningEffortId, userAgent } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildModelCatalog } from 'harness-test/catalog'
import { assemble } from './assemble.ts'
import * as Copilot from '../src/index.ts'
import { Options as Config } from '../src/config.ts'
type Protocol = 'openai-responses' | 'anthropic-messages'
import { CopilotModelCatalog } from '../src/catalog.ts'
import { CopilotApiAdapter } from '../src/provider.ts'
import { gateway, MODEL_ID, MODEL_LIST } from './fixtures.ts'
import type { Gateway } from './fixtures.ts'

const contexts: Context[] = []
const gateways: Gateway[] = []
const catalogs: CopilotModelCatalog[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(catalogs.splice(0).map(catalog => catalog.dispose()))
  await Promise.all(gateways.splice(0).map(server => server.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

async function host(protocol: Protocol, options: Record<string, unknown> = {}) {
  const server = await gateway(protocol)
  gateways.push(server)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  vi.stubEnv('COPILOT_TEST_KEY', 'gateway-secret')
  const { withoutV1, ...settings } = options
  const fiber = await ctx.plugin(Copilot, {
    baseURL: withoutV1 === true ? server.url.slice(0, -3) : server.url, apiKey: 'COPILOT_TEST_KEY', protocol,
    headers: { 'X-Custom-Header': 'custom-value', 'User-Agent': 'claude-cli/forbidden' }, ...settings,
  })
  return { ctx, server, fiber }
}

function request(sessionId = 'main-session') {
  return {
    provider: 'copilot-api', model: MODEL_ID, reasoningEffort: ReasoningEffortId('high'),
    sessionId: SessionId(sessionId), messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
  }
}

describe.each(['openai-responses', 'anthropic-messages'] as const)('copilot-api %s inference', (protocol) => {
  it('uses the shared Codex credential by default for discovery and inference', async () => {
    vi.stubEnv('GITHUB_COPILOT_API_KEY', 'shared-gateway-secret')
    const { ctx, server } = await host(protocol, { apiKey: undefined })
    expect(ctx.llm.listConfigurableProviders()).toMatchObject([{
      nativeAuth: { env: ['GITHUB_COPILOT_API_KEY'] },
    }])
    expect((await assemble(ctx, request())).finish).toEqual({ kind: 'stop' })
    expect(server.requests.map(row => row.method)).toEqual(['GET', 'POST'])
    for (const row of server.requests) {
      if (protocol === 'openai-responses') expect(row.headers.authorization).toBe('Bearer shared-gateway-secret')
      else expect(row.headers['x-api-key']).toBe('shared-gateway-secret')
    }
  })
  it('sends every selectable effort without promoting or inventing levels', async () => {
    const { ctx, server } = await host(protocol)
    const info = await ctx.llm.resolveModelInfo('copilot-api', MODEL_ID)
    for (const effort of info.reasoning?.efforts ?? []) {
      const selected = await ctx.llm.resolveCallConfig({ provider: 'copilot-api', model: MODEL_ID, reasoningEffort: effort.id })
      expect((await assemble(ctx, { ...request(), ...selected })).finish).toEqual({ kind: 'stop' })
      const sent = server.requests.filter(row => row.method === 'POST').at(-1)!
      if (protocol === 'openai-responses') expect(sent.body.reasoning).toEqual(effort.id === 'off' ? { effort: 'none' } : { effort: effort.id, summary: 'auto' })
      else expect(sent.body.output_config).toEqual({ effort: effort.id })
    }
  })
  it('accepts a base URL without /v1 and delegates the final URL to the SDK', async () => {
    const { ctx, server } = await host(protocol, { withoutV1: true })
    expect((await assemble(ctx, request())).finish).toEqual({ kind: 'stop' })
    expect(server.requests.map(row => row.path.split('?')[0])).toEqual([
      '/gateway/v1/models', `/gateway/v1/${protocol === 'openai-responses' ? 'responses' : 'messages'}`,
    ])
  })
  it('publishes discovered efforts to the real browser catalog and sends the selected effort on the wire', async () => {
    const { ctx, server } = await host(protocol)
    const catalog = await buildModelCatalog(ctx, { provider: 'copilot-api', model: MODEL_ID })
    const efforts = catalog.groups[0]?.models[0]?.reasoning?.efforts.map(effort => effort.id)
    expect(efforts).toEqual(protocol === 'openai-responses'
      ? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max'])
    expect(catalog.failures).toEqual([])
    expect(await ctx.llm.listModels('copilot-api')).toMatchObject([{ id: MODEL_ID, inputModalities: ['text', 'image'] }, { id: 'provider/text-only', inputModalities: ['text'] }])
    const call = await ctx.llm.resolveCallConfig({ provider: 'copilot-api', model: MODEL_ID, reasoningEffort: ReasoningEffortId('xhigh') })
    const result = await assemble(ctx, { ...request(), ...call })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 3 })
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/gateway/v1/models', headers: {
      'x-custom-header': 'custom-value', 'user-agent': userAgent(),
    } })
    const sent = server.requests.find(row => row.method === 'POST')
    expect(sent?.path.split('?')[0]).toBe(`/gateway/v1/${protocol === 'openai-responses' ? 'responses' : 'messages'}`)
    expect(sent?.headers).toMatchObject({
      'x-custom-header': 'custom-value', 'user-agent': userAgent(), 'content-type': 'application/json',
      'x-deepseek-harness-session-id': 'main-session',
    })
    expect(sent?.headers['x-session-affinity']).toBeUndefined()
    expect(sent?.body.model).toBe(MODEL_ID)
    if (protocol === 'openai-responses') {
      expect(sent?.headers.authorization).toBe('Bearer gateway-secret')
      expect(sent?.headers['x-client-request-id']).toBe('main-session')
      expect(sent?.body.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
      expect(sent?.body.prompt_cache_key).toBe('main-session')
    } else {
      expect(sent?.headers['x-api-key']).toBe('gateway-secret')
      expect(sent?.headers['anthropic-version']).toBe('2023-06-01')
      expect(sent?.body.output_config).toEqual({ effort: 'xhigh' })
      expect(sent?.body.thinking).toMatchObject({ type: 'adaptive' })
    }
    await expect(ctx.llm.resolveCallConfig({ provider: 'copilot-api', model: 'provider/text-only', reasoningEffort: ReasoningEffortId('high') }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })

  it('keeps main, child, and unrelated sessions isolated with optional affinity', async () => {
    const { ctx, server } = await host(protocol, { sessionAffinity: true })
    await Promise.all(['main-session', 'child-session', 'other-session'].map(id => assemble(ctx, request(id))))
    const sent = server.requests.filter(row => row.method === 'POST')
    expect(new Set(sent.map(row => row.headers['x-deepseek-harness-session-id']))).toEqual(new Set(['main-session', 'child-session', 'other-session']))
    for (const row of sent) {
      expect(row.headers['x-session-affinity']).toBe(row.headers['x-deepseek-harness-session-id'])
      if (protocol === 'openai-responses') expect(row.body.prompt_cache_key).toBe(row.headers['x-deepseek-harness-session-id'])
    }
    expect(server.requests.filter(row => row.method === 'GET')).toHaveLength(1)
  })

  it('preserves tool calling and a multi-turn tool result through pi-ai', async () => {
    const { ctx, server } = await host(protocol)
    server.tool = true
    const tools = [{ name: 'lookup', description: 'Lookup a value', parameters: { type: 'object', properties: { key: { type: 'number' } }, required: ['key'] } }]
    const first = await assemble(ctx, { ...request(), tools })
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    const tool = first.message.content.find(block => block.type === 'tool-call')
    if (tool?.type !== 'tool-call') throw new Error('no streamed tool call')
    expect(tool).toMatchObject({ name: 'lookup', arguments: '{"key":1}' })
    server.tool = false
    const second = await assemble(ctx, {
      ...request(), tools,
      messages: [...request().messages, first.message, createToolResultMessage({ callId: tool.id, content: [{ type: 'text', text: '42' }], isError: false })],
    })
    expect(second.message.content).toEqual([{ type: 'text', text: 'hello' }])
    const payload = server.requests.filter(row => row.method === 'POST')[1]?.body
    expect(JSON.stringify(payload)).toContain(protocol === 'openai-responses' ? 'function_call_output' : 'tool_result')
    expect(JSON.stringify(payload)).toContain('42')
  })

  it('cancels an active SSE request through the caller AbortSignal', async () => {
    const { ctx, server } = await host(protocol)
    server.hold = true
    const controller = new AbortController()
    const result = assemble(ctx, { ...request(), signal: controller.signal })
    await vi.waitFor(() => { expect(server.requests.some(row => row.method === 'POST')).toBe(true) })
    controller.abort('user cancelled')
    expect((await result).finish.kind).toBe('aborted')
    await vi.waitFor(() => { expect(server.closed).toBeGreaterThan(1) })
  })

  it('sends actual image bytes from the durable Harness attachment store', async () => {
    const { ctx, server } = await host(protocol)
    const root = await mkdtemp(join(tmpdir(), 'copilot-vision-'))
    roots.push(root)
    await ctx.plugin(LocalAttachments, { dshHome: root })
    const image = await ctx.attachments.saveImage({
      mediaType: 'image/png',
      data: Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')),
    })
    const messages = [createUserMessage({ content: [{ type: 'text', text: 'describe this image' }, { type: 'image', attachment: image }], source: { kind: 'user' } })]
    expect((await assemble(ctx, { ...request(), messages })).finish).toEqual({ kind: 'stop' })
    const body = server.requests.find(row => row.method === 'POST')?.body
    expect(JSON.stringify(body)).toContain(protocol === 'openai-responses' ? 'input_image' : '"type":"image"')
    expect(JSON.stringify(body)).toContain(protocol === 'openai-responses' ? 'data:image/png;base64,' : '"type":"base64"')
    const { reasoningEffort: _effort, ...plain } = request()
    expect((await assemble(ctx, { ...plain, model: 'provider/text-only', messages })).finish).toEqual({ kind: 'stop' })
    const textOnly = server.requests.filter(row => row.method === 'POST')[1]?.body
    expect(JSON.stringify(textOnly)).not.toContain('data:image/')
    expect(JSON.stringify(textOnly)).not.toContain('"type":"base64"')
  })

  it('removes route and discovery registrations when its plugin unloads', async () => {
    const { ctx, fiber } = await host(protocol)
    await ctx.llm.listModels('copilot-api')
    await fiber.dispose()
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })
})

describe('copilot-api reasoning off', () => {
  it('merges a configured Messages beta with pi-ai required beta features', async () => {
    const { ctx, server } = await host('anthropic-messages', {
      headers: { 'Anthropic-Beta': 'custom-beta', 'X-Custom-Header': 'custom-value' },
      modelOverrides: { [MODEL_ID]: { compat: { forceAdaptiveThinking: false } } },
    })
    const result = await assemble(ctx, request())
    expect(result.finish).toEqual({ kind: 'stop' })
    const beta = server.requests.find(row => row.method === 'POST')?.headers['anthropic-beta']
    expect(beta).toContain('custom-beta')
    expect(beta).toContain('interleaved-thinking-2025-05-14')
  })

  it('sends explicit none only when the directory advertises it, and otherwise omits reasoning', async () => {
    const { ctx, server } = await host('openai-responses')
    await assemble(ctx, { ...request(), reasoningEffort: ReasoningEffortId('off') })
    expect(server.requests.find(row => row.method === 'POST')?.body.reasoning).toEqual({ effort: 'none' })
    const { reasoningEffort: _effort, ...plain } = request()
    await assemble(ctx, { ...plain, model: 'provider/text-only' })
    expect(server.requests.filter(row => row.method === 'POST')[1]?.body).not.toHaveProperty('reasoning')
  })
})

describe('copilot-api directory refresh', () => {
  it('exposes native model discovery, refreshes the live directory, and rejects unsaved endpoint/protocol drafts', async () => {
    const { ctx, server } = await host('openai-responses')
    expect((await ctx.llm.discoverModels('copilot-api-provider', { provider: 'copilot-api' }))[0]).toMatchObject({
      id: MODEL_ID, contextWindow: 128000, inputModalities: ['text', 'image'],
    })
    server.models = { data: [{ id: 'another/model', reasoning_efforts: ['high'] }] }
    expect(await ctx.llm.discoverModels('copilot-api-provider', { baseURL: server.url })).toMatchObject([{ id: 'another/model' }])
    expect((await ctx.llm.listModels('copilot-api')).map(model => model.id)).toEqual(['another/model'])
    await expect(ctx.llm.discoverModels('copilot-api-provider', { baseURL: 'http://localhost:1' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(ctx.llm.discoverModels('copilot-api-provider', { provider: 'copilot-api', api: 'anthropic-messages' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('refreshes periodically without requiring the model settings page', async () => {
    const { ctx, server } = await host('openai-responses', { modelRefreshInterval: 20 })
    await ctx.llm.listModels('copilot-api')
    server.models = { data: [{ id: 'new/image', input_modalities: ['image'], reasoning_efforts: ['low'] }] }
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('copilot-api')).map(model => model.id)).toEqual(['new/image'])
    })
  })

  it('shares initial discovery without letting one cancelled waiter cancel another', async () => {
    const { catalog } = await directory()
    const controller = new AbortController()
    const cancelled = catalog.ensure(controller.signal)
    const waiting = catalog.ensure()
    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'ABORTED' })
    await waiting
    expect(catalog.models).toHaveLength(2)
  })

  async function directory(options: Record<string, unknown> = {}) {
    const server = await gateway('openai-responses')
    gateways.push(server)
    const config = Config({ baseURL: server.url, ...options })
    const warnings: string[] = []
    const catalog = new CopilotModelCatalog(config, server.url, () => Promise.resolve('key'), () => {}, message => warnings.push(message))
    catalogs.push(catalog)
    const adapter = new CopilotApiAdapter(catalog, {
      resolveApiKey: () => Promise.resolve('key'),
    })
    return { server, catalog, adapter, warnings }
  }

  it('retains a successful catalog after HTTP and malformed refresh failures', async () => {
    const { server, catalog, adapter, warnings } = await directory()
    await catalog.refresh()
    const profiles = catalog.profiles
    server.modelStatus = 503
    await catalog.refresh()
    expect(catalog.profiles).toBe(profiles)
    expect(await adapter.listModels('copilot-api')).toHaveLength(2)
    server.modelStatus = 200
    server.models = { error: 'bad catalog' }
    await catalog.refresh()
    expect(catalog.profiles).toBe(profiles)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('using the last successful catalog')
    const chunks = []
    for await (const chunk of adapter.stream(request())) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('freezes metadata and wire behavior for a prepared call during a refresh', async () => {
    const { server, catalog, adapter } = await directory()
    const call = await adapter.prepareCall('copilot-api', MODEL_ID)
    server.models = { data: [{ ...MODEL_LIST.data[0], reasoning_efforts: ['low'], context_window: 32000 }] }
    await catalog.refresh()
    expect((await adapter.resolveModel('copilot-api', MODEL_ID)).reasoning?.efforts.map(effort => effort.id)).toEqual(['low'])
    const chunks = []
    for await (const chunk of call.stream(request())) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(server.requests.find(row => row.method === 'POST')?.body.reasoning).toMatchObject({ effort: 'high' })
  })

  it('accepts a successful empty catalog and rejects an oversized initial response', async () => {
    const empty = await directory()
    empty.server.models = { data: [] }
    expect(await empty.adapter.listModels('copilot-api')).toEqual([])
    const bounded = await directory({ maxModelResponseBytes: 4 })
    await expect(bounded.catalog.refresh()).rejects.toMatchObject({ code: 'MODEL_DISCOVERY_FAILED' })
    expect(bounded.catalog.models).toBeUndefined()
  })
})
