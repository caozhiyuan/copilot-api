/** Real Loader/profile composition resolves secure credentials and registers a usable catalog. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { afterEach, expect, it, vi } from 'vitest'
import { profileComposition } from 'harness-test/profile-composition'
import { buildModelCatalog } from 'harness-test/catalog'
import { assemble } from './assemble.ts'
import * as SourcePlugin from '../src/index.ts'
import * as BuiltPlugin from '../dist/index.js'
import { gateway, MODEL_ID } from './fixtures.ts'
import type { Gateway } from './fixtures.ts'

let ctx: Context | undefined
let root: string | undefined
let server: Gateway | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  await server?.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it.each([['TypeScript source', SourcePlugin], ['built JavaScript', BuiltPlugin]] as const)('loads %s through cordis.yml with a credentials-store key', async (_label, Copilot) => {
  root = await mkdtemp(join(tmpdir(), 'copilot-loader-'))
  server = await gateway('openai-responses')
  const credentialPath = join(root, 'credentials.yaml')
  await writeFile(credentialPath, 'version: 1\nrefs:\n  COPILOT_LOADER_KEY: stored-secret\n', { mode: 0o600 })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: llm', "  name: test-llm-service",
    '- id: credentials', "  name: '@deepseek-ai/dsh-credentials-local'", '  config:', `    path: ${JSON.stringify(credentialPath)}`,
    '- id: copilot-api-provider', "  name: 'copilot-api-provider'", '  config:',
    `    baseURL: ${server.url}`, '    apiKey: COPILOT_LOADER_KEY', '    protocol: openai-responses',
    '    headers:', '      X-Custom-Header: loader-custom', '',
  ].join('\n'))
  ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['test-llm-service', LlmRuntime], ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['copilot-api-provider', Copilot],
  ])
  const internal: ModuleLoaderV2 = {
    version: 'v2', loadCache: new Map(),
    import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader module: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
    register(): never { throw new Error('unexpected registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job') },
    resolveSync(): never { throw new Error('unexpected sync resolution') },
    load(): never { throw new Error('unexpected load') },
  }
  ctx.loader.internal = internal
  await profileComposition(ctx, root, configPath)
  const catalog = await buildModelCatalog(ctx, { provider: 'copilot-api', model: MODEL_ID })
  expect(catalog.groups[0]?.models[0]?.reasoning?.efforts.map(effort => effort.id)).toContain('xhigh')
  expect(ctx.llm.listConfigurableProviders()).toMatchObject([{
    provider: 'copilot-api', settingsNs: 'copilot-api-provider', settingsPath: [],
  }])
  expect((await assemble(ctx, { provider: 'copilot-api', model: MODEL_ID, messages: [] })).finish).toEqual({ kind: 'stop' })
  expect(server.requests.find(row => row.method === 'POST')?.headers).toMatchObject({
    authorization: 'Bearer stored-secret', 'x-custom-header': 'loader-custom',
  })
  const page = ctx.settings.describe().find(row => row.ns === 'copilot-api-provider')
  expect(page).toBeDefined()
  await ctx.settings.mutate('copilot-api-provider', [{ op: 'set', path: ['modelOverrides', MODEL_ID], value: {
    name: 'Updated live', input: ['text'], reasoningEfforts: { low: 'low' },
  } }], page?.revision)
  await vi.waitFor(async () => {
    expect((await ctx!.llm.resolveModelInfo('copilot-api', MODEL_ID)).reasoning?.efforts.map(effort => effort.id)).toEqual(['low'])
  })
  expect((await ctx.llm.listModels('copilot-api'))[0]).toMatchObject({ name: 'Updated live', inputModalities: ['text'] })
  await ctx.credentials.set(credentialRef('COPILOT_LOADER_KEY'), 'rotated-secret')
  expect((await assemble(ctx, { provider: 'copilot-api', model: MODEL_ID, messages: [] })).finish).toEqual({ kind: 'stop' })
  expect(server.requests.filter(row => row.method === 'POST').at(-1)?.headers.authorization).toBe('Bearer rotated-secret')
})
