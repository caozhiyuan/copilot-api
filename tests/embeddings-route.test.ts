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

const testHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "copilot-api-embeddings-route-"),
)
process.env.COPILOT_API_HOME = testHome

const [{ accountsManager }, { getAdminDb }, { state }, { embeddingRoutes }] =
  await Promise.all([
    import("~/lib/accounts-manager"),
    import("~/lib/admin-db"),
    import("~/lib/state"),
    import("~/routes/embeddings/route"),
  ])

type SelectionResult = Awaited<
  ReturnType<(typeof accountsManager)["selectAccountForRequest"]>
>
type SelectionOk = Extract<SelectionResult, { ok: true }>

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
        streaming: false,
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
    selectedModel: buildModel("text-embedding-3-small"),
    endpoint: "/embeddings",
    costUnits: 0,
  }
}

function createUnreadableResponse(status: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("body exploded"))
      },
    }),
    { status },
  )
}

beforeEach(() => {
  state.manualApprove = false
  state.verbose = false

  getAdminDb().run("DELETE FROM request_log;")

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve(buildSelection())
  accountsManager.finalizeQuota = () => Promise.resolve()
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

describe("embeddings unauthorized classification", () => {
  test("ownership mismatch 401 does not trigger markAccountFailed", async () => {
    const markFailedSpy = mock(() => {})
    accountsManager.markAccountFailed = markFailedSpy

    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            message:
              'input item ID "msg_abc" does not belong to this connection',
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    )
    fetchHolder.fetch = fetchMock as unknown as typeof fetch

    const response = await embeddingRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(401)
    expect(markFailedSpy).not.toHaveBeenCalled()
  })

  test("unreadable 401 body does not trigger markAccountFailed", async () => {
    const markFailedSpy = mock(() => {})
    accountsManager.markAccountFailed = markFailedSpy

    const fetchMock = mock(() => Promise.resolve(createUnreadableResponse(401)))
    fetchHolder.fetch = fetchMock as unknown as typeof fetch

    const response = await embeddingRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: "hello",
        }),
      }),
    )

    expect(response.status).toBe(401)
    expect(markFailedSpy).not.toHaveBeenCalled()
  })
})
