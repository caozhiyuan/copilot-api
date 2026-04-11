import { expect, mock, test } from "bun:test"

import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { completionRoutes } from "~/routes/chat-completions/route"
import { messageRoutes } from "~/routes/messages/route"
import { responsesRoutes } from "~/routes/responses/route"

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

type SseEvent = {
  event?: string
  data: string
}

type RouteLike = {
  fetch: (request: Request) => Response | Promise<Response>
}

function parseSse(body: string): Array<SseEvent> {
  const blocks = body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  return blocks.map((block) => {
    const lines = block.split("\n")
    let event: string | undefined
    const dataLines: Array<string> = []

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim() || undefined
        continue
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim())
      }
    }

    return {
      event,
      data: dataLines.join("\n"),
    }
  })
}

function buildTestAccount(): AccountRuntime {
  return {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghp_test",
    copilotToken: "copilot_test",
    vsCodeVersion: "1.0.0",
  }
}

function buildTestModel(id: string): Model {
  return {
    id,
    name: id,
    vendor: "upstream",
    object: "model",
    preview: false,
    version: "test",
    model_picker_enabled: true,
    capabilities: {
      family: "test",
      limits: {},
      object: "capabilities",
      supports: { streaming: true },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function createBrokenSseResponse(): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("stream exploded"))
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  )
}

async function withMockedStreamingEndpoint<T>(params: {
  route: RouteLike
  request: Request
  endpoint: string
  upstreamPath: string
  assert: (response: Response) => Promise<T>
}): Promise<T> {
  const { route, request, endpoint, upstreamPath, assert } = params

  const originalSelect =
    accountsManager.selectAccountForRequest.bind(accountsManager)
  const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)

  const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
  const originalFetch = fetchHolder.fetch

  const selection: SelectionOk = {
    ok: true,
    account: buildTestAccount(),
    selectedModel: buildTestModel("gpt-test"),
    endpoint,
    costUnits: 0,
  }

  const selectMock = () => Promise.resolve(selection)

  accountsManager.selectAccountForRequest =
    selectMock as typeof accountsManager.selectAccountForRequest
  accountsManager.finalizeQuota =
    (async () => {}) as typeof accountsManager.finalizeQuota

  const fetchMock = mock((input: Request | URL | string) => {
    let url: string

    if (typeof input === "string") {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }

    if (url.includes(upstreamPath)) {
      return createBrokenSseResponse()
    }

    return new Response("not found", { status: 404 })
  })

  fetchHolder.fetch = fetchMock as unknown as typeof fetch

  try {
    return await assert(await route.fetch(request))
  } finally {
    // eslint-disable-next-line require-atomic-updates
    accountsManager.selectAccountForRequest = originalSelect
    // eslint-disable-next-line require-atomic-updates
    accountsManager.finalizeQuota = originalFinalize
    fetchHolder.fetch = originalFetch
  }
}

test("messages route emits Anthropic error event when translated stream fails", async () => {
  await withMockedStreamingEndpoint({
    route: {
      fetch: (request) => Promise.resolve(messageRoutes.fetch(request)),
    },
    endpoint: "/chat/completions",
    upstreamPath: "/chat/completions",
    request: new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    assert: async (response) => {
      expect(response.status).toBe(200)

      const events = parseSse(await response.text())
      const errorEvent = events.at(-1)

      expect(errorEvent?.event).toBe("error")
      expect(JSON.parse(errorEvent?.data ?? "null")).toEqual({
        type: "error",
        error: {
          type: "api_error",
          message: "stream exploded",
        },
      })
    },
  })
})

test("chat completions route emits error chunk and DONE when stream fails", async () => {
  await withMockedStreamingEndpoint({
    route: {
      fetch: (request) => Promise.resolve(completionRoutes.fetch(request)),
    },
    endpoint: "/chat/completions",
    upstreamPath: "/chat/completions",
    request: new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
    assert: async (response) => {
      expect(response.status).toBe(200)

      const events = parseSse(await response.text())
      const errorEvent = events.at(-2)
      const doneEvent = events.at(-1)

      expect(JSON.parse(errorEvent?.data ?? "null")).toEqual({
        error: {
          message: "stream exploded",
          type: "error",
        },
      })
      expect(doneEvent?.data).toBe("[DONE]")
    },
  })
})

test("responses route emits native error event when stream fails", async () => {
  await withMockedStreamingEndpoint({
    route: {
      fetch: (request) => Promise.resolve(responsesRoutes.fetch(request)),
    },
    endpoint: "/responses",
    upstreamPath: "/responses",
    request: new Request("http://local/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        input: "hi",
      }),
    }),
    assert: async (response) => {
      expect(response.status).toBe(200)

      const events = parseSse(await response.text())
      const errorEvent = events.at(-1)

      expect(errorEvent?.event).toBe("error")
      expect(JSON.parse(errorEvent?.data ?? "null")).toEqual({
        type: "error",
        code: null,
        message: "stream exploded",
        param: null,
        sequence_number: 0,
      })
    },
  })
})
