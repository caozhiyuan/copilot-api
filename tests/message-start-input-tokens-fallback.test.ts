import { expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

import { accountsManager } from "~/lib/accounts-manager"
import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"
import { messageRoutes } from "~/routes/messages/route"

type TestConfig = Record<string, unknown>

type SseEvent = {
  event?: string
  data: string
}

function parseSse(body: string): Array<SseEvent> {
  const blocks = body
    .split("\n\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0)

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

async function withConfig(config: TestConfig, run: () => Promise<void>) {
  const original = await fs
    .readFile(PATHS.CONFIG_PATH, "utf8")
    .catch(() => null)
  await fs.mkdir(path.dirname(PATHS.CONFIG_PATH), { recursive: true })
  await fs.writeFile(
    PATHS.CONFIG_PATH,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
  mergeConfigWithDefaults()

  try {
    await run()
  } finally {
    // eslint-disable-next-line unicorn/prefer-ternary
    if (original === null) {
      await fs.rm(PATHS.CONFIG_PATH, { force: true })
    } else {
      await fs.writeFile(PATHS.CONFIG_PATH, original, "utf8")
    }
    mergeConfigWithDefaults()
  }
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

test("message_start input_tokens is 0 when fallback disabled (chat.completions stream)", async () => {
  await withConfig(
    {
      messageStartInputTokensFallback: false,
    },
    async () => {
      const originalSelect =
        accountsManager.selectAccountForRequest.bind(accountsManager)
      const originalFinalize =
        accountsManager.finalizeQuota.bind(accountsManager)

      const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
      const originalFetch = fetchHolder.fetch

      accountsManager.selectAccountForRequest = () =>
        Promise.resolve({
          ok: true,
          account: buildTestAccount(),
          selectedModel: buildTestModel("gpt-test"),
          endpoint: "/chat/completions",
          costUnits: 0,
        })

      accountsManager.finalizeQuota = async () => {}

      const upstreamSse =
        "data: "
        + JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              delta: { content: "Hello" },
              finish_reason: null,
              logprobs: null,
            },
          ],
        })
        + "\n\n"
        + "data: "
        + JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
              logprobs: null,
            },
          ],
        })
        + "\n\n"
        + "data: [DONE]\n\n"

      const fetchMock = mock((url: string) => {
        if (url.includes("/chat/completions")) {
          return new Response(upstreamSse, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          })
        }

        return new Response("not found", { status: 404 })
      })

      // @ts-expect-error - mock doesn't implement full fetch signature
      fetchHolder.fetch = fetchMock

      try {
        const payload = {
          model: "gpt-test",
          stream: true,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
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

        const body = await res.text()
        const events = parseSse(body)

        const messageStart = events.find((e) => e.event === "message_start")
        expect(messageStart).toBeTruthy()

        const parsed = JSON.parse(messageStart?.data ?? "null") as {
          type: string
          message?: { usage?: { input_tokens?: number } }
        }

        expect(parsed.type).toBe("message_start")
        expect(parsed.message?.usage?.input_tokens).toBe(0)
      } finally {
        // eslint-disable-next-line require-atomic-updates
        accountsManager.selectAccountForRequest = originalSelect
        // eslint-disable-next-line require-atomic-updates
        accountsManager.finalizeQuota = originalFinalize
        fetchHolder.fetch = originalFetch
      }
    },
  )
})

test("message_start input_tokens is 0 when fallback disabled (responses stream)", async () => {
  await withConfig(
    {
      messageStartInputTokensFallback: false,
    },
    async () => {
      const originalSelect =
        accountsManager.selectAccountForRequest.bind(accountsManager)
      const originalFinalize =
        accountsManager.finalizeQuota.bind(accountsManager)

      const fetchHolder = globalThis as unknown as { fetch: typeof fetch }
      const originalFetch = fetchHolder.fetch

      accountsManager.selectAccountForRequest = () =>
        Promise.resolve({
          ok: true,
          account: buildTestAccount(),
          selectedModel: buildTestModel("gpt-test"),
          endpoint: "/responses",
          costUnits: 0,
        })

      accountsManager.finalizeQuota = async () => {}

      const responseBase = {
        id: "resp_test",
        object: "response",
        created_at: 0,
        model: "gpt-test",
        output: [],
        output_text: "",
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        metadata: null,
        parallel_tool_calls: false,
        temperature: null,
        tool_choice: null,
        tools: [],
        top_p: null,
      }

      const upstreamSse =
        "event: response.created\n"
        + "data: "
        + JSON.stringify({
          type: "response.created",
          sequence_number: 0,
          response: responseBase,
        })
        + "\n\n"
        + "event: response.completed\n"
        + "data: "
        + JSON.stringify({
          type: "response.completed",
          sequence_number: 1,
          response: responseBase,
        })
        + "\n\n"

      const fetchMock = mock((url: string) => {
        if (url.includes("/responses")) {
          return new Response(upstreamSse, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
            },
          })
        }

        return new Response("not found", { status: 404 })
      })

      // @ts-expect-error - mock doesn't implement full fetch signature
      fetchHolder.fetch = fetchMock

      try {
        const payload = {
          model: "gpt-test",
          stream: true,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
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

        const body = await res.text()
        const events = parseSse(body)

        const messageStart = events.find((e) => e.event === "message_start")
        expect(messageStart).toBeTruthy()

        const parsed = JSON.parse(messageStart?.data ?? "null") as {
          type: string
          message?: { usage?: { input_tokens?: number } }
        }

        expect(parsed.type).toBe("message_start")
        expect(parsed.message?.usage?.input_tokens).toBe(0)
      } finally {
        // eslint-disable-next-line require-atomic-updates
        accountsManager.selectAccountForRequest = originalSelect
        // eslint-disable-next-line require-atomic-updates
        accountsManager.finalizeQuota = originalFinalize
        fetchHolder.fetch = originalFetch
      }
    },
  )
})
