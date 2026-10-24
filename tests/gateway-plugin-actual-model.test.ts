import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { GatewayPlugins, type GatewayPluginEvents } from "~/lib/gateway-plugins"
import {
  requestEventsMiddleware,
  setPluginRequestModel,
} from "~/lib/request-events"
import { state } from "~/lib/state"
import { traceIdMiddleware } from "~/lib/trace"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import { createResponses } from "~/services/copilot/create-responses"
import { forwardCodexResponses } from "~/services/codex/create-responses"
import { forwardGoogleGenerateContent } from "~/services/providers/google"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"
import {
  handleResponses,
  responsesHandlerDependencies,
} from "~/routes/responses/handler"
import {
  alphaSearchRouteDependencies,
  handleAlphaSearchRequest,
} from "~/routes/alpha-search/route"

const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  codexAccessToken: state.codexAccessToken,
  codexAccountId: state.codexAccountId,
  macMachineId: state.macMachineId,
  vsCodeDeviceId: state.vsCodeDeviceId,
  vsCodeSessionId: state.vsCodeSessionId,
  vsCodeVersion: state.vsCodeVersion,
}
const originalResponses = { ...responsesHandlerDependencies }
const originalAlpha = { ...alphaSearchRouteDependencies }
const runtimes: Array<GatewayPlugins> = []
const fetchSpy = spyOn(globalThis, "fetch")
afterAll(() => {
  fetchSpy.mockRestore()
})
const provider: ResolvedProviderConfig = {
  name: "test-provider",
  type: "anthropic",
  apiKey: "test-key",
  authType: "authorization",
  baseUrl: "https://provider.invalid",
}
const target = "resolved-model"
const messages = () => ({
  model: target,
  max_tokens: 10,
  messages: [{ role: "user" as const, content: "hello" }],
})
const responses = () => ({ model: target, input: "hello", stream: false })
const options = {
  vision: false,
  initiator: "user" as const,
  requestId: "request-1",
}

beforeEach(() => {
  Object.assign(state, {
    accountType: "individual",
    copilotToken: "test-token",
    codexAccessToken: "test-codex-token",
    codexAccountId: "test-account",
    macMachineId: "test-machine",
    vsCodeDeviceId: "test-device",
    vsCodeSessionId: "test-session",
    vsCodeVersion: "test-version",
  })
  fetchSpy.mockClear()
  fetchSpy.mockImplementation(
    Object.assign(
      () =>
        Promise.resolve(
          Response.json({ model: "response-public-name", usage: null }),
        ),
      { preconnect: () => {} },
    ),
  )
})

afterEach(async () => {
  Object.assign(state, originalState)
  Object.assign(responsesHandlerDependencies, originalResponses)
  Object.assign(alphaSearchRouteDependencies, originalAlpha)
  await Promise.all(runtimes.splice(0).map((plugins) => plugins.close()))
})

async function createApp() {
  const plugins = new GatewayPlugins(5000)
  runtimes.push(plugins)
  const actuals: Array<GatewayPluginEvents["request.actual_model"]> = []
  const ends: Array<GatewayPluginEvents["request.end"]> = []
  const usages: Array<GatewayPluginEvents["usage.recorded"]> = []
  await plugins.register("collector", ({ on }) => {
    on("request.actual_model", (e) => {
      actuals.push(e)
    })
    on("request.end", (e) => {
      ends.push(e)
    })
    on("usage.recorded", (e) => {
      usages.push(e)
    })
  })
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.use(requestEventsMiddleware(plugins, 5000))
  return { app, plugins, actuals, ends, usages }
}

const cases: Array<[string, () => Promise<unknown>, string]> = [
  [
    "Copilot Chat Completions",
    () => createChatCompletions(messages(), { requestId: "request-1" }),
    target,
  ],
  [
    "Copilot Messages",
    () => createMessages(messages(), undefined, { requestId: "request-1" }),
    target,
  ],
  [
    "Copilot Responses HTTP",
    () => createResponses(responses(), options),
    target,
  ],
  [
    "Copilot Responses WebSocket",
    () =>
      createResponses(
        { ...responses(), stream: true },
        { ...options, transport: "websocket" },
      ),
    target,
  ],
  [
    "provider Messages",
    () => forwardProviderMessages(provider, messages(), new Headers()),
    target,
  ],
  [
    "provider Chat Completions",
    () => forwardProviderChatCompletions(provider, messages(), new Headers()),
    target,
  ],
  [
    "provider Responses",
    () => forwardProviderResponses(provider, responses(), new Headers()),
    target,
  ],
  [
    "Codex Responses HTTP",
    () =>
      forwardCodexResponses(responses(), new Headers(), undefined, {
        transport: "http",
      }),
    target,
  ],
  [
    "Codex Responses WebSocket",
    () =>
      forwardCodexResponses(
        { ...responses(), stream: true },
        new Headers(),
        undefined,
        { transport: "websocket" },
      ),
    target,
  ],
  [
    "Google model URL",
    () =>
      forwardGoogleGenerateContent(
        { ...provider, type: "google" },
        `models/${target}`,
        {
          contents: [],
          generationConfig: { candidateCount: 1, maxOutputTokens: 10 },
        },
        new Headers(),
        { stream: false, clientSignal: new AbortController().signal },
      ),
    target,
  ],
]

test.each(cases)(
  "%s exposes the resolved target separately from the request model",
  async (name, invoke, expected) => {
    const { app, plugins, actuals, ends, usages } = await createApp()
    app.post("/v1/messages", async (c) => {
      setPluginRequestModel("client-alias")
      const result = await invoke()
      if (result instanceof Response) await result.text()
      return c.text("ok")
    })
    const response = await app.request("/v1/messages", { method: "POST" })
    await response.text()
    await plugins.flush()
    expect(actuals).toHaveLength(1)
    expect(actuals[0]).toMatchObject({
      model: "client-alias",
      actualModel: expected,
    })
    expect(ends[0]).toMatchObject({
      model: "client-alias",
      actualModel: expected,
    })
    expect(usages).toHaveLength(0)
    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledTimes(name.includes("WebSocket") ? 0 : 1)
    const call = fetchSpy.mock.calls[0]
    if (call) {
      const [input, init] = call
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes(":generateContent")) {
        expect(url).toContain(`/models/${expected}:generateContent`)
      } else {
        expect(JSON.parse(init!.body as string)).toMatchObject({
          model: expected,
        })
      }
    }
  },
)

test("publishes the actual model before the upstream responds, including failed requests without usage", async () => {
  const { app, plugins, actuals, ends, usages } = await createApp()
  let rejectUpstream = (_error: Error) => {}
  const gate = new Promise<Response>((_resolve, reject) => {
    rejectUpstream = reject
  })
  fetchSpy.mockImplementation(
    Object.assign(() => gate, { preconnect: () => {} }),
  )
  let actualReady = () => {}
  const ready = new Promise<void>((resolve) => {
    actualReady = resolve
  })
  await plugins.register("ready", ({ on }) => {
    on("request.actual_model", actualReady)
  })
  app.post("/v1/messages", async (c) => {
    setPluginRequestModel("client-alias")
    try {
      await createMessages(messages(), undefined, { requestId: "request-1" })
    } catch {
      return c.text("upstream failed", 502)
    }
    return c.text("ok")
  })
  const pending = app.request("/v1/messages", { method: "POST" })
  await ready
  expect(actuals[0].actualModel).toBe(target)
  expect(ends).toHaveLength(0)
  rejectUpstream(new Error("upstream unavailable"))
  await (await pending).text()
  await plugins.flush()
  expect(ends[0]).toMatchObject({
    actualModel: target,
    outcome: "error",
    status: 502,
  })
  expect(usages).toHaveLength(0)
})

test("the real Responses handler records the mapped and normalized target, preserving the request alias", async () => {
  const { app, plugins, actuals, ends } = await createApp()
  responsesHandlerDependencies.resolveMappedModel = () => "mapped-model"
  responsesHandlerDependencies.findEndpointModel = () => ({
    id: target,
    name: target,
    object: "model",
    model_picker_enabled: true,
    preview: false,
    vendor: "test",
    version: "1",
    capabilities: {
      family: "test",
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "test",
      type: "chat",
    },
    supported_endpoints: ["/responses"],
  })
  app.post("/v1/responses", handleResponses)
  await (
    await app.request("/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "client-alias",
        input: "hello",
        stream: false,
      }),
    })
  ).text()
  await plugins.flush()
  expect(actuals[0]).toMatchObject({
    model: "client-alias",
    actualModel: target,
  })
  expect(ends[0]).toMatchObject({ model: "client-alias", actualModel: target })
  expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toMatchObject({
    model: target,
  })
})

test("alpha search exposes the Codex priority override from its existing parsed payload", async () => {
  const { app, plugins, actuals, ends } = await createApp()
  alphaSearchRouteDependencies.resolveMappedModel = (model) => model
  alphaSearchRouteDependencies.isAlphaSearchCodexPriorityEnabled = () => true
  alphaSearchRouteDependencies.resolveProviderConfig = () =>
    Promise.resolve({ ...provider, name: "codex", type: "openai-responses" })
  alphaSearchRouteDependencies.forwardCodexAlphaSearch = async (request) => {
    expect(await request.json()).toMatchObject({ model: "gpt-5.6-luna" })
    return Response.json({ ok: true })
  }
  app.post("/alpha/search", (c) => handleAlphaSearchRequest(c))
  await (
    await app.request("/alpha/search", {
      method: "POST",
      body: JSON.stringify({ model: "claude-client" }),
    })
  ).text()
  await plugins.flush()
  expect(actuals[0]).toMatchObject({
    model: "claude-client",
    actualModel: "gpt-5.6-luna",
  })
  expect(ends[0].actualModel).toBe("gpt-5.6-luna")
})
