/** Session-derived snapshots through real AgentLoop requests, children, and retries. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
import { buildModelCatalog } from 'harness-test/catalog'
import * as Copilot from '../index.js'
import { gateway, MODEL_ID } from './fixtures.ts'
import type { Gateway } from './fixtures.ts'

let context: Context | undefined
let server: Gateway | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  await server?.dispose()
  context = undefined
  server = undefined
  vi.unstubAllEnvs()
})

it.each(['openai-responses', 'anthropic-messages'] as const)('keeps %s retry headers and usage in each original Agent Session', async (protocol) => {
  server = await gateway(protocol)
  const ctx = new Context()
  context = ctx
  vi.stubEnv('COPILOT_AGENT_KEY', 'agent-secret')
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Retry)
  await ctx.plugin(Copilot, {
    baseURL: server.url, protocol, apiKey: 'COPILOT_AGENT_KEY', sessionAffinity: true,
    headers: { 'X-Custom-Header': 'agent-custom' },
    retryPolicy: { mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  })
  const harness = await mountAgentLoopTestHarness(ctx)
  const options = { provider: 'copilot-api', model: MODEL_ID, reasoningEffort: ReasoningEffortId('high') }
  const parent = await harness.create(SessionId('parent-session'), options)
  const childHandle = await ctx.agents.create({
    sessionId: SessionId('child-session'), parentAgent: parent,
    meta: { parentSession: parent.session.id, origin: 'subagent' }, agentOptions: options,
  })
  const child = childHandle.agent
  const unrelated = await harness.create(SessionId('other-session'), options)
  server.failNext = 1
  for (const agent of [parent, child, unrelated]) {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'say hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.data.usage).toMatchObject({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 3 })
  }
  const sent = server.requests.filter(row => row.method === 'POST')
  expect(sent.map(row => row.headers['x-deepseek-harness-session-id'])).toEqual(['parent-session', 'parent-session', 'child-session', 'other-session'])
  for (const row of sent) {
    expect(row.headers['x-session-affinity']).toBe(row.headers['x-deepseek-harness-session-id'])
    expect(row.headers['x-custom-header']).toBe('agent-custom')
    expect(row.headers[protocol === 'openai-responses' ? 'authorization' : 'x-api-key']).toBe(protocol === 'openai-responses' ? 'Bearer agent-secret' : 'agent-secret')
  }
  const catalog = await buildModelCatalog(ctx, options)
  expect(catalog.groups[0]?.models[0]?.reasoning?.efforts.map(effort => effort.id)).toContain('high')
  expect([parent, child, unrelated].map(agent => agent.session.id)).toEqual(['parent-session', 'child-session', 'other-session'])
  expect(child.session.header.parentSession).toBe('parent-session')
})
