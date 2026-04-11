import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

import { getUUID } from "~/lib/utils"

const testHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "copilot-api-chat-completions-session-id-"),
)
process.env.COPILOT_API_HOME = testHome

const [{ accountsManager }, { getAdminDb }, { state }, { completionRoutes }] =
  await Promise.all([
    import("~/lib/accounts-manager"),
    import("~/lib/admin-db"),
    import("~/lib/state"),
    import("~/routes/chat-completions/route"),
  ])

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

type FetchOptions = {
  headers?: Record<string, string>
}

const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
const originalFetch = fetchHolder.fetch
const originalSelect =
  accountsManager.selectAccountForRequest.bind(accountsManager)
const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)
const originalMarkFailed =
  accountsManager.markAccountFailed.bind(accountsManager)

function buildAccount(): AccountRuntime {
  return {
    id: "octocat",
    accountType: "individual",
    addedAt: Date.now(),
    githubToken: "ghu_test",
    copilotToken: "copilot_test",
    vsCodeVersion: "1.0.0",
    premiumRemaining: 10,
    unlimited: false,
  }
}

function buildModel(id: string): Model {
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
      limits: {
        max_output_tokens: 8192,
        max_prompt_tokens: 200_000,
      },
      object: "capabilities",
      supports: {
        adaptive_thinking: true,
        streaming: true,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

function buildSelection(): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel("gpt-4o-mini"),
    endpoint: "/chat/completions",
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
    affinityCacheKey: "test-cache-key",
    selectionReason: "affinity_miss",
  }
}

function buildChatCompletionResponse(model: string) {
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    created: Date.now(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "ok",
        },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
}

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM request_log;")

  accountsManager.finalizeQuota = () => Promise.resolve()
  accountsManager.markAccountFailed = () => {}
})

afterEach(() => {
  fetchHolder.fetch = originalFetch
  accountsManager.selectAccountForRequest = originalSelect
  accountsManager.finalizeQuota = originalFinalize
  accountsManager.markAccountFailed = originalMarkFailed
})

afterAll(async () => {
  await fs.rm(testHome, { recursive: true, force: true })
})

test("uses x-session-id for upstream interaction id when no other session key exists", async () => {
  let selectionRequestId: string | undefined
  let upstreamInteractionId: string | undefined

  accountsManager.selectAccountForRequest = (_candidates, options) => {
    selectionRequestId = options?.requestId
    return Promise.resolve(buildSelection())
  }

  const fetchMock = mock((_url: string, options?: FetchOptions) => {
    upstreamInteractionId = options?.headers?.["x-interaction-id"]
    return Promise.resolve(
      new Response(JSON.stringify(buildChatCompletionResponse("gpt-4o-mini")), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })
  fetchHolder.fetch = fetchMock as unknown as typeof fetch

  const headerSessionId = "chat-header-session-only"

  const response = await completionRoutes.fetch(
    new Request("http://local/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": headerSessionId,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(selectionRequestId).toBe(getUUID(headerSessionId))
  expect(upstreamInteractionId).toBe(getUUID(headerSessionId))
})
