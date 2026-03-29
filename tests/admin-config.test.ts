import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import { mergeConfigWithDefaults } from "~/lib/config"
import { PATHS } from "~/lib/paths"

type TestConfig = Record<string, unknown>

const withConfig = async (config: TestConfig, run: () => Promise<void>) => {
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

test("POST /api/admin/config updates useMessagesApi", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useMessagesApi: false }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { useMessagesApi?: boolean }
    expect(body.useMessagesApi).toBe(false)
  })
})

test("POST /api/admin/config updates useResponsesApiWebSearch", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ useResponsesApiWebSearch: false }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      useResponsesApiWebSearch?: boolean
    }
    expect(body.useResponsesApiWebSearch).toBe(false)
  })
})

test("POST /api/admin/config updates anthropicApiKey", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ anthropicApiKey: "  sk-ant-test  " }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { anthropicApiKey?: string }
    expect(body.anthropicApiKey).toBe("sk-ant-test")
  })
})

test("POST /api/admin/config clears anthropicApiKey", async () => {
  await withConfig({ anthropicApiKey: "sk-ant-test" }, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ anthropicApiKey: "" }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as { anthropicApiKey?: string }
    expect(body.anthropicApiKey).toBeUndefined()
  })
})

test("POST /api/admin/config updates responsesApiContextManagementModels", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          responsesApiContextManagementModels: [" gpt-5-mini ", "gpt-5-mini"],
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      responsesApiContextManagementModels?: Array<string>
    }
    expect(body.responsesApiContextManagementModels).toEqual(["gpt-5-mini"])
  })
})

test("POST /api/admin/config rejects invalid responsesApiContextManagementModels entries", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          responsesApiContextManagementModels: [""],
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain(
      "responsesApiContextManagementModels[0]",
    )
  })
})

test("POST /api/admin/config updates providers", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              type: "anthropic",
              enabled: true,
              baseUrl: "https://example.com",
              apiKey: "sk-test",
              models: {
                "kimi-k2.5": {
                  temperature: 1,
                  topP: 0.95,
                },
              },
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      providers: {
        custom: {
          type: string
          enabled: boolean
          baseUrl: string
          apiKey: string
          models: {
            "kimi-k2.5": {
              temperature: number
              topP: number
            }
          }
        }
      }
    }

    expect(body.providers.custom.type).toBe("anthropic")
    expect(body.providers.custom.enabled).toBe(true)
    expect(body.providers.custom.baseUrl).toBe("https://example.com")
    expect(body.providers.custom.apiKey).toBe("sk-test")
    expect(body.providers.custom.models["kimi-k2.5"].temperature).toBe(1)
    expect(body.providers.custom.models["kimi-k2.5"].topP).toBe(0.95)
  })
})

test("POST /api/admin/config rejects case-insensitive duplicate providers", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            Anthropic: { type: "anthropic" },
            anthropic: { type: "anthropic" },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("conflicts with another provider")
  })
})

test("POST /api/admin/config rejects unsupported provider keys", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              type: "anthropic",
              foo: "bar",
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("providers.custom.foo")
  })
})

test("POST /api/admin/config rejects unsupported provider types", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          providers: {
            custom: {
              type: "openai",
            },
          },
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("providers.custom.type")
  })
})

test("POST /api/admin/config rejects unknown top-level config keys", async () => {
  await withConfig({}, async () => {
    const { server } = await import("../src/server")

    const res = await server.fetch(
      new Request("http://localhost/api/admin/config", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          notARealKey: true,
        }),
      }),
    )

    expect(res.status).toBe(400)

    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain("Unknown config key: notARealKey")
  })
})
