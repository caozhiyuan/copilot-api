import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

import { getUUID } from "~/lib/utils"

const testHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "copilot-api-responses-prompt-cache-key-"),
)
process.env.COPILOT_API_HOME = testHome

const [{ accountsManager }, { getAdminDb }, { state }, { responsesRoutes }] =
  await Promise.all([
    import("~/lib/accounts-manager"),
    import("~/lib/admin-db"),
    import("~/lib/state"),
    import("~/routes/responses/route"),
  ])

type RequestLogSnapshot = {
  prompt_cache_key: string | null
  affinity_key_used: string | null
  affinity_key_source: string | null
  selection_reason: string | null
}

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

type FetchOptions = {
  body?: unknown
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

function buildSelection(endpoint: string, modelId: string): SelectionOk {
  return {
    ok: true,
    account: buildAccount(),
    selectedModel: buildModel(modelId),
    endpoint,
    costUnits: 0,
    confirmAffinity: mock(() => {}),
    affinityHit: false,
    affinityCacheKey: "test-cache-key",
    selectionReason: "affinity_miss",
  }
}

function buildResponsesResult(model: string, text: string) {
  return {
    id: "resp_1",
    object: "response",
    created_at: Date.now(),
    model,
    output: [
      {
        id: "out_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: [],
          },
        ],
      },
    ],
    output_text: text,
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
  }
}

function getLatestRequestLog(): RequestLogSnapshot | null {
  return getAdminDb()
    .query(
      "SELECT prompt_cache_key, affinity_key_used, affinity_key_source, selection_reason FROM request_log ORDER BY id DESC LIMIT 1;",
    )
    .get() as RequestLogSnapshot | null
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
  // getAdminDb() is a shared singleton for the Bun test process.
  // Closing it here makes later test files fail with "Database has closed".
  await fs.rm(testHome, { recursive: true, force: true })
})

describe("responses request log prompt_cache_key persistence", () => {
  test("prefers payload.prompt_cache_key over metadata user_id session_id", async () => {
    let selectionRequestId: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionRequestId = options?.requestId
      return Promise.resolve(buildSelection("/responses", "responses-model"))
    }

    const fetchMock = mock((_url: string, _opts?: FetchOptions) => {
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const input = "hello"
    const payloadPromptCacheKey = "payload-cache-key"
    const metadataSessionId = "metadata-session"

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "original-model",
          input,
          prompt_cache_key: payloadPromptCacheKey,
          metadata: {
            user_id: JSON.stringify({
              device_id: "device-1",
              session_id: metadataSessionId,
            }),
          },
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(getLatestRequestLog()?.prompt_cache_key).toBe(payloadPromptCacheKey)
    expect(selectionRequestId).toBe(payloadPromptCacheKey)

    const log = getLatestRequestLog()
    expect(log?.affinity_key_used).toBe(payloadPromptCacheKey)
    expect(log?.affinity_key_source).toBe("prompt_cache_key")
    expect(log?.selection_reason).toBe("affinity_miss")
  })

  test("falls back to metadata user_id session_id when payload.prompt_cache_key is missing", async () => {
    let selectionRequestId: string | undefined

    accountsManager.selectAccountForRequest = (_candidates, options) => {
      selectionRequestId = options?.requestId
      return Promise.resolve(buildSelection("/responses", "responses-model"))
    }

    const fetchMock = mock((_url: string, _opts?: FetchOptions) => {
      return Promise.resolve(
        new Response(
          JSON.stringify(buildResponsesResult("responses-model", "ok")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
    })

    // @ts-expect-error test mock only implements the used subset
    fetchHolder.fetch = fetchMock

    const input = "hello"
    const metadataSessionId = "metadata-session"

    const response = await responsesRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "original-model",
          input,
          metadata: {
            user_id: JSON.stringify({
              device_id: "device-1",
              session_id: metadataSessionId,
            }),
          },
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(getLatestRequestLog()?.prompt_cache_key).toBe(metadataSessionId)
    expect(selectionRequestId).toBe(getUUID(metadataSessionId))

    const log = getLatestRequestLog()
    expect(log?.affinity_key_used).toBe(metadataSessionId)
    expect(log?.affinity_key_source).toBe("metadata_session_id")
    expect(log?.selection_reason).toBe("affinity_miss")
  })
})
