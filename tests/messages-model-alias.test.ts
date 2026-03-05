import { expect, mock, test } from "bun:test"

import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { messageRoutes } from "~/routes/messages/route"

type FetchOpts = {
  body?: string
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

test("messages endpoint sends selected model id instead of alias", async () => {
  const originalSelect =
    accountsManager.selectAccountForRequest.bind(accountsManager)
  const originalFinalize = accountsManager.finalizeQuota.bind(accountsManager)

  const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
  const originalFetch = fetchHolder.fetch

  let upstreamModel: string | undefined

  accountsManager.selectAccountForRequest = () =>
    Promise.resolve({
      ok: true,
      account: buildTestAccount(),
      selectedModel: buildTestModel("claude-sonnet-4"),
      endpoint: "/v1/messages",
      costUnits: 0,
    })

  accountsManager.finalizeQuota = async () => {}

  const fetchMock = mock((url: string, opts: FetchOpts) => {
    if (url.includes("/v1/messages")) {
      const bodyRaw = typeof opts.body === "string" ? opts.body : "{}"
      const parsed = JSON.parse(bodyRaw) as { model?: string }
      upstreamModel = parsed.model

      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      )
    }

    return new Response("not found", { status: 404 })
  })

  // @ts-expect-error - mock doesn't implement full fetch signature
  fetchHolder.fetch = fetchMock

  try {
    const payload = {
      model: "my-claude",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }

    const res = await messageRoutes.fetch(
      new Request("http://local/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    )

    expect(res.status).toBe(200)
    expect(upstreamModel).toBe("claude-sonnet-4")
  } finally {
    // eslint-disable-next-line require-atomic-updates
    accountsManager.selectAccountForRequest = originalSelect
    // eslint-disable-next-line require-atomic-updates
    accountsManager.finalizeQuota = originalFinalize
    fetchHolder.fetch = originalFetch
  }
})
