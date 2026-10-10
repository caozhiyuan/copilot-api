import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { ResponsesPayload } from "~/lib/types/responses"
import { installModelsDevCatalog } from "~/lib/models-dev-cache"

import { modelsDevProviderCatalogFixture } from "./fixtures/models-dev-catalog"

// Existing route tests replace ES modules; run real-config integration checks
// in a subprocess so those mocks cannot affect credential and account behavior.
if (process.env.COPILOT_API_XAI_TEST_PROCESS !== "1") {
  test("xAI provider integration in an isolated process", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "tests/xai-provider.test.ts"],
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, COPILOT_API_XAI_TEST_PROCESS: "1" },
    })
    if (result.exitCode !== 0)
      throw new Error(
        new TextDecoder().decode(result.stdout)
          + new TextDecoder().decode(result.stderr),
      )
    expect(result.exitCode).toBe(0)
  })
} else {
  const { default: consola } = await import("consola")
  const { Hono } = await import("hono")
  const { runAuthLogin, runAuthAccounts } = await import("~/auth")
  const { modelRoutes } = await import("~/routes/models/route")
  const { providerModelRoutes } = await import("~/routes/provider/models/route")
  const {
    getProviderConfig,
    getRawProviderConfig,
    invalidateConfigCache,
    listEnabledProviders,
  } = await import("~/lib/config")
  const { PATHS } = await import("~/lib/paths")
  const { resolveProviderConfig } = await import("~/lib/provider-resolver")
  const { requestContext } = await import("~/lib/request-context")
  const {
    getXaiAccessToken,
    persistXaiCredentials,
    readXaiCredentials,
    getXaiAccounts,
    selectXaiAccount,
    removeXaiAccount,
  } = await import("~/lib/xai-token")
  const {
    buildProviderUpstreamHeaders,
    resolveProviderEndpointUrl,
    forwardProviderResponses,
  } = await import("~/services/providers/provider-proxy")

  const savedPaths = { ...PATHS }
  const originalFetch = globalThis.fetch
  const credentials = {
    accountId: "xai-account",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
  }
  let taskDir: string

  beforeEach(() => {
    installModelsDevCatalog(modelsDevProviderCatalogFixture)
    taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-xai-"))
    PATHS.APP_DIR = taskDir
    PATHS.CONFIG_PATH = path.join(taskDir, "config.json")
    PATHS.GITHUB_TOKEN_PATH = path.join(taskDir, "github_token")
    PATHS.XAI_CREDENTIAL_PATH = path.join(taskDir, "xai_credentials.json")
    fs.writeFileSync(PATHS.CONFIG_PATH, "{}")
    invalidateConfigCache()
    for (const level of ["info", "success", "log"] as const)
      spyOn(consola, level).mockImplementation(
        Object.assign(() => {}, { raw: () => {} }),
      )
  })

  afterEach(() => {
    mock.restore()
    globalThis.fetch = originalFetch
    Object.assign(PATHS, savedPaths)
    invalidateConfigCache()
    if (!taskDir.startsWith(path.join(os.tmpdir(), "copilot-api-xai-")))
      throw new Error("Invalid test directory")
    fs.rmSync(taskDir, { recursive: true, force: true })
  })

  function writeConfig(providers: Record<string, unknown>) {
    fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify({ providers }))
    invalidateConfigCache()
  }

  function setFetch(
    fetcher: (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => Promise<Response>,
  ) {
    globalThis.fetch = Object.assign(fetcher, { preconnect: () => {} })
  }

  describe("xAI provider credentials", () => {
    test("stores tokens separately and preserves model settings on reauthorization", async () => {
      writeConfig({
        xai: {
          enabled: false,
          type: "openai-compatible",
          apiKey: "old-api-key",
          agentsModels: ["grok-test"],
          models: { "grok-test": { temperature: 0.3 } },
        },
      })
      await persistXaiCredentials(credentials)
      expect(await readXaiCredentials()).toEqual(credentials)
      expect(getRawProviderConfig("xai")).toMatchObject({
        enabled: true,
        authType: "oauth2",
        type: "openai-responses",
        baseUrl: "https://cli-chat-proxy.grok.com",
        agentsModels: ["grok-test"],
        models: { "grok-test": { temperature: 0.3 } },
      })
      expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).not.toContain("token")
      expect(getRawProviderConfig("xai")?.apiKey).toBeUndefined()
      expect(getRawProviderConfig("xai")?.modelsDevProviderId).toBeUndefined()
      if (process.platform !== "win32")
        expect(fs.statSync(PATHS.XAI_CREDENTIAL_PATH).mode & 0o777).toBe(0o600)
    })

    test("resolves OAuth without an API key and forwards only the xAI bearer token", async () => {
      await persistXaiCredentials(credentials)
      expect(getProviderConfig("xai")?.authType).toBe("oauth2")
      expect(listEnabledProviders()).toContain("xai")
      const provider = await resolveProviderConfig(" xai ")
      expect(provider?.type).toBe("openai-responses")
      expect(provider?.apiKey).toBe(credentials.accessToken)
      expect(resolveProviderEndpointUrl(provider!, "responses")).toBe(
        "https://cli-chat-proxy.grok.com/v1/responses",
      )
      expect(
        buildProviderUpstreamHeaders(
          provider!,
          new Headers({ authorization: "Bearer gateway-key" }),
        ).authorization,
      ).toBe("Bearer access-token")
      setFetch(() =>
        Promise.reject(new Error("Should not refresh a fresh token")),
      )
      expect(await getXaiAccessToken()).toBe(credentials.accessToken)
    })

    test("returns null for missing credentials or a disabled OAuth provider", async () => {
      expect(await readXaiCredentials()).toBeNull()
      expect(await getXaiAccessToken()).toBeNull()
      writeConfig({
        xai: {
          type: "openai-responses",
          authType: "oauth2",
          baseUrl: "https://api.x.ai",
        },
      })
      expect(await resolveProviderConfig("xai")).toBeNull()
      writeConfig({ xai: { enabled: false, authType: "oauth2" } })
      expect(await resolveProviderConfig("xai")).toBeNull()
    })

    test("continues to support an xAI provider configured with an API key", async () => {
      writeConfig({
        xai: {
          type: "openai-compatible",
          baseUrl: "https://api.x.ai",
          apiKey: "xai-api-key",
        },
      })
      const provider = await resolveProviderConfig("xai")
      expect(provider?.apiKey).toBe("xai-api-key")
      expect(resolveProviderEndpointUrl(provider!, "chat/completions")).toBe(
        "https://api.x.ai/v1/chat/completions",
      )
      expect(fs.existsSync(PATHS.XAI_CREDENTIAL_PATH)).toBe(false)
    })

    test.each([
      ["https://api.x.ai/", "https://cli-chat-proxy.grok.com"],
      ["https://custom.example", "https://custom.example"],
    ])(
      "resolves existing OAuth config at %s without rewriting it",
      async (baseUrl, expected) => {
        await persistXaiCredentials(credentials)
        writeConfig({
          xai: { type: "openai-responses", authType: "oauth2", baseUrl },
        })
        const provider = await resolveProviderConfig("xai")
        expect(provider?.baseUrl).toBe(expected)
        expect(provider?.apiKey).toBe(credentials.accessToken)
        expect(resolveProviderEndpointUrl(provider!, "responses")).toBe(
          `${expected}/v1/responses`,
        )
        expect(getRawProviderConfig("xai")?.baseUrl).toBe(baseUrl)
      },
    )

    test.each([
      "not-json",
      JSON.stringify({ ...credentials, expiresAt: "invalid" }),
    ])("reports invalid stored credentials", async (content) => {
      fs.writeFileSync(PATHS.XAI_CREDENTIAL_PATH, content)
      const error: unknown = await readXaiCredentials().catch(
        (cause: unknown) => cause,
      )
      expect((error as Error).message).toContain("xAI credentials file")
    })

    test("keeps filesystem and validation errors visible", async () => {
      fs.mkdirSync(PATHS.XAI_CREDENTIAL_PATH)
      expect(
        await readXaiCredentials().catch((error: unknown) => error),
      ).toBeInstanceOf(Error)
      expect(
        await persistXaiCredentials({ ...credentials, refreshToken: "" }).catch(
          (error: unknown) => error,
        ),
      ).toBeInstanceOf(Error)
    })

    test("shares concurrent refreshes and persists rotated tokens without changing configuration", async () => {
      await persistXaiCredentials({ ...credentials, expiresAt: 1 })
      const config = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
      const fetcher = mock(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          expect(
            new URLSearchParams(init?.body as URLSearchParams).get(
              "refresh_token",
            ),
          ).toBe(credentials.refreshToken)
          await Bun.sleep(10)
          return Response.json({
            access_token: "refreshed",
            refresh_token: "rotated",
            expires_in: 3600,
          })
        },
      )
      setFetch(fetcher)
      const providers = await Promise.all(
        Array.from({ length: 8 }, () => resolveProviderConfig("xai")),
      )
      expect(
        providers.every((provider) => provider?.apiKey === "refreshed"),
      ).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await readXaiCredentials()).toMatchObject({
        accessToken: "refreshed",
        refreshToken: "rotated",
      })
      expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe(config)
    })

    test("retries failed refreshes without losing the last saved credentials", async () => {
      const expired = { ...credentials, expiresAt: 1 }
      await persistXaiCredentials(expired)
      setFetch(() =>
        Promise.resolve(
          Response.json({ error: "invalid_grant" }, { status: 400 }),
        ),
      )
      expect(
        ((await getXaiAccessToken().catch((error: unknown) => error)) as Error)
          .message,
      ).toContain("invalid_grant")
      expect(await readXaiCredentials()).toEqual(expired)
      expect(fs.existsSync(`${PATHS.XAI_CREDENTIAL_PATH}.lock`)).toBe(false)
      setFetch(() =>
        Promise.resolve(
          Response.json({ access_token: "retry-token", expires_in: 3600 }),
        ),
      )
      expect(await getXaiAccessToken()).toBe("retry-token")
    })

    test("retries persisting a rotated refresh token without refreshing it twice", async () => {
      await persistXaiCredentials({ ...credentials, expiresAt: 1 })
      const fetcher = mock(() =>
        Promise.resolve(
          Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          }),
        ),
      )
      setFetch(fetcher)
      spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
        throw new Error("Credential persistence failed")
      })
      const failure: unknown = await getXaiAccessToken().catch(
        (error: unknown) => error,
      )
      expect((failure as Error).message).toBe("Credential persistence failed")
      expect((await readXaiCredentials())?.refreshToken).toBe(
        credentials.refreshToken,
      )
      expect(await getXaiAccessToken()).toBe("rotated-access")
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect((await readXaiCredentials())?.refreshToken).toBe("rotated-refresh")
    })

    test("serializes new sign-ins with an in-flight refresh so old tokens cannot overwrite them", async () => {
      await persistXaiCredentials({ ...credentials, expiresAt: 1 })
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<Response>()
      setFetch(() => {
        started.resolve()
        return response.promise
      })
      const refresh = getXaiAccessToken()
      await started.promise
      const newCredentials = {
        ...credentials,
        accessToken: "new-login",
        refreshToken: "new-login-refresh",
      }
      const login = persistXaiCredentials(newCredentials)
      response.resolve(
        Response.json({
          access_token: "old-refreshed",
          refresh_token: "old-rotated",
          expires_in: 3600,
        }),
      )
      await Promise.all([refresh, login])
      expect(await readXaiCredentials()).toEqual(newCredentials)
      expect((await resolveProviderConfig("xai"))?.apiKey).toBe("new-login")
    })

    test("CLI login configures xAI and stores the device flow result", async () => {
      let requests = 0
      setFetch((input) => {
        requests++
        return Promise.resolve(
          Response.json(
            (
              (typeof input === "string" ? input
              : input instanceof URL ? input.href
              : input.url
              ).endsWith("device/code")
            ) ?
              {
                device_code: "private-code",
                user_code: "PUBLIC-CODE",
                verification_uri: "https://auth.x.ai/device",
              }
            : {
                access_token: "cli-access",
                refresh_token: "cli-refresh",
                expires_in: 3600,
                id_token: `header.${Buffer.from(JSON.stringify({ sub: credentials.accountId })).toString("base64url")}.signature`,
              },
          ),
        )
      })
      await runAuthLogin({ provider: "xai", verbose: false, showToken: false })
      expect(requests).toBe(2)
      expect(getRawProviderConfig("xai")?.authType).toBe("oauth2")
      expect(getRawProviderConfig("xai")?.type).toBe("openai-responses")
      expect(await readXaiCredentials()).toMatchObject({
        accessToken: "cli-access",
        refreshToken: "cli-refresh",
      })
      expect(consola.log).toHaveBeenCalledWith("https://auth.x.ai/device")
      expect(consola.log).not.toHaveBeenCalledWith("cli-access")
    })

    test("lists cached models.dev xAI models in provider and aggregated endpoints without upstream discovery", async () => {
      await persistXaiCredentials(credentials)
      const upstream = mock(() =>
        Promise.reject(new Error("Model listing must stay local")),
      )
      setFetch(upstream)
      const app = new Hono()
        .route("/v1/models", modelRoutes)
        .route("/:provider/v1/models", providerModelRoutes)
      const raw = await app.request("/xai/v1/models")
      const body = (await raw.json()) as {
        data: Array<{ id: string; context_window: number }>
      }
      expect(raw.status).toBe(200)
      expect(body.data.map((model) => model.id)).toEqual([
        "grok-4.7",
        "grok-catalog-only",
      ])
      expect(body.data[0].context_window).toBe(500_000)
      const aggregated = await app.request("/v1/models")
      const models = (await aggregated.json()) as {
        data: Array<{ id: string }>
      }
      expect(models.data.map((model) => model.id)).toEqual([
        "xai/grok-4.7",
        "xai/grok-catalog-only",
      ])
      expect(upstream).not.toHaveBeenCalled()
      const codex = await app.request("/v1/models", {
        headers: { "user-agent": "codex/1.0" },
      })
      const catalog = (await codex.json()) as {
        models: Array<{ slug: string }>
      }
      expect(
        catalog.models.some((model) => model.slug === "xai/grok-4.7"),
      ).toBe(true)
    })

    test("supports three accounts, reauthorization, switching and removal without leaking credentials", async () => {
      for (let index = 1; index <= 3; index++)
        await persistXaiCredentials(
          {
            ...credentials,
            accountId: `account-${index}`,
            accessToken: `access-${index}`,
          },
          { alias: `Work-${index}` },
        )
      expect(
        (await getXaiAccounts())
          .filter((account) => account.active)
          .map((account) => account.accountId),
      ).toEqual(["account-3"])
      expect(JSON.stringify(await getXaiAccounts())).not.toContain("access-")
      const extra: unknown = await persistXaiCredentials({
        ...credentials,
        accountId: "fourth",
      }).catch((error: unknown) => error)
      expect((extra as Error).message).toBe("xAI supports at most 3 accounts")
      await persistXaiCredentials({
        ...credentials,
        accountId: "account-1",
        accessToken: "reauthorized",
      })
      expect((await getXaiAccounts()).length).toBe(3)
      expect((await getXaiAccounts())[0].alias).toBe("Work-1")
      expect(await getXaiAccessToken()).toBe("reauthorized")
      await selectXaiAccount("work-2")
      expect(getRawProviderConfig("xai")?.type).toBe("openai-responses")
      expect(await getXaiAccessToken()).toBe("access-2")
      expect((await removeXaiAccount("Work-1")).active).toBe(false)
      expect((await getXaiAccounts()).length).toBe(2)
      await runAuthAccounts("xai", { use: "work-3" })
      expect(await getXaiAccessToken()).toBe("access-3")
      await runAuthAccounts("xai", { list: true })
      await runAuthAccounts("xai", { remove: "work-2" })
      expect((await getXaiAccounts()).length).toBe(1)
    })

    test("rejects duplicate aliases, active removal, empty and unknown selectors", async () => {
      await persistXaiCredentials(credentials, { alias: "Work" })
      const second = { ...credentials, accountId: "second" }
      for (const alias of ["work", credentials.accountId]) {
        expect(
          await persistXaiCredentials(second, { alias }).catch(
            (error: unknown) => error,
          ),
        ).toBeInstanceOf(Error)
      }
      for (const operation of [
        () => removeXaiAccount("Work"),
        () => selectXaiAccount(""),
        () => removeXaiAccount("unknown"),
      ]) {
        expect(
          await operation().catch((error: unknown) => error),
        ).toBeInstanceOf(Error)
      }
    })

    test("does not recreate an account removed during a refresh", async () => {
      await persistXaiCredentials({ ...credentials, expiresAt: 1 })
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<Response>()
      setFetch(() => {
        started.resolve()
        return response.promise
      })
      const refresh = getXaiAccessToken()
      await started.promise
      await persistXaiCredentials({
        ...credentials,
        accountId: "other",
        accessToken: "other-access",
      })
      await removeXaiAccount(credentials.accountId)
      response.resolve(
        Response.json({
          access_token: "stale-refresh",
          refresh_token: "stale-rotated",
          expires_in: 3600,
        }),
      )
      expect(await refresh).toBeNull()
      expect(
        (await getXaiAccounts()).map((account) => account.accountId),
      ).toEqual(["other"])
    })
  })

  describe("xAI Grok Build Responses requests", () => {
    const uuidPattern =
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
    const grokHeaderNames = [
      "x-xai-token-auth",
      "x-authenticateresponse",
      "x-grok-client-version",
      "x-grok-client-identifier",
      "x-grok-client-mode",
      "x-grok-model-override",
      "x-grok-conv-id",
      "x-grok-session-id",
      "x-grok-req-id",
    ]
    const createProvider = (
      overrides: Partial<ResolvedProviderConfig> = {},
    ): ResolvedProviderConfig => ({
      name: "xai",
      type: "openai-responses",
      authType: "oauth2",
      baseUrl: "https://cli-chat-proxy.grok.com",
      apiKey: credentials.accessToken,
      ...overrides,
    })

    function captureRequests() {
      const requests: Array<{
        url: string
        init: RequestInit | undefined
      }> = []
      setFetch((input, init) => {
        if (input === "https://x.ai/cli/stable") {
          return Promise.resolve(new Response("1.0.47\n"))
        }
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          init,
        })
        return Promise.resolve(
          new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      })
      return requests
    }

    async function forward(
      payload: ResponsesPayload,
      provider = createProvider(),
      headers = new Headers(),
    ) {
      const response = await forwardProviderResponses(
        provider,
        payload,
        headers,
      )
      await response.text()
    }

    const runWithSession = <T>(
      callback: () => T,
      sessionAffinity = "stable-affinity",
    ): T =>
      requestContext.run(
        {
          traceId: "test-trace",
          startTime: Date.now(),
          userAgent: "test-agent",
          sessionAffinity,
          parentSessionId: undefined,
        },
        callback,
      )

    test.each([false, true])(
      "uses the official Responses URL and headers (stream=%s)",
      async (stream) => {
        await persistXaiCredentials(credentials)
        const provider = await resolveProviderConfig("xai")
        const requests = captureRequests()
        const payload: ResponsesPayload = {
          model: "grok-4.7",
          input: "hello",
          stream,
          prompt_cache_key: "stable-cache-key",
        }
        await runWithSession(() =>
          forward(
            payload,
            provider!,
            new Headers({
              authorization: "Bearer gateway-key",
              accept: "text/event-stream",
              "x-grok-client-version": "0.0.1",
              "x-grok-req-id": "client-request-id",
            }),
          ),
        )
        expect(requests).toHaveLength(1)
        expect(requests[0].url).toBe(
          "https://cli-chat-proxy.grok.com/v1/responses",
        )
        const headers = new Headers(requests[0].init?.headers)
        expect(Object.fromEntries(headers)).toMatchObject({
          authorization: "Bearer access-token",
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-xai-token-auth": "xai-grok-cli",
          "x-authenticateresponse": "authenticate-response",
          "x-grok-client-version": "1.0.47",
          "x-grok-client-identifier": "grok-shell",
          "x-grok-client-mode": "headless",
          "x-grok-model-override": payload.model,
          "x-grok-conv-id": payload.prompt_cache_key,
          "x-grok-session-id": payload.prompt_cache_key,
        })
        expect(headers.get("x-grok-req-id")).toMatch(uuidPattern)
        expect(requests[0].init?.body).toBe(JSON.stringify(payload))
      },
    )

    test("keeps the cache key and session stable while generating a new request ID", async () => {
      const requests = captureRequests()
      const payload: ResponsesPayload = {
        model: "grok-4.7",
        input: "hello",
        prompt_cache_key: "  original-cache-key  ",
      }
      await Promise.all([forward(payload), forward(payload)])
      expect(requests).toHaveLength(2)
      const headers = requests.map(
        (request) => request.init?.headers as Record<string, string>,
      )
      for (const [index, header] of headers.entries()) {
        expect(header["x-grok-session-id"]).toBe(payload.prompt_cache_key!)
        expect(header["x-grok-conv-id"]).toBe(payload.prompt_cache_key!)
        expect(header["x-grok-req-id"]).toMatch(uuidPattern)
        expect(requests[index].init?.body).toBe(JSON.stringify(payload))
      }
      expect(headers[0]["x-grok-req-id"]).not.toBe(headers[1]["x-grok-req-id"])
      expect(payload.prompt_cache_key).toBe("  original-cache-key  ")
    })

    test.each([undefined, null, "", "  "])(
      "uses stable session affinity when the cache key is %s",
      async (cacheKey) => {
        const requests = captureRequests()
        const payload: ResponsesPayload = {
          model: "grok-4.7",
          input: "hello",
          prompt_cache_key: cacheKey,
        }
        await runWithSession(() =>
          Promise.all([forward(payload), forward(payload)]),
        )
        const headers = requests.map(
          (request) => new Headers(request.init?.headers),
        )
        for (const [index, header] of headers.entries()) {
          expect(header.get("x-grok-session-id")).toBe("stable-affinity")
          expect(header.get("x-grok-conv-id")).toBe("stable-affinity")
          expect(requests[index].init?.body).toBe(JSON.stringify(payload))
        }
        expect(headers[0].get("x-grok-req-id")).not.toBe(
          headers[1].get("x-grok-req-id"),
        )
      },
    )

    test.each([undefined, null, "", "  "])(
      "rejects a missing or blank session key before forwarding (%s)",
      async (cacheKey) => {
        const requests = captureRequests()
        const payload: ResponsesPayload = {
          model: "grok-4.7",
          input: "hello",
          prompt_cache_key: cacheKey,
        }
        for (const attempt of [
          () => forward(payload),
          () => runWithSession(() => forward(payload), "  "),
        ]) {
          const error: unknown = await attempt().catch(
            (error: unknown) => error,
          )
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toBe(
            "xAI OAuth Responses requests require prompt_cache_key or session affinity",
          )
        }
        expect(requests).toHaveLength(0)
        expect(payload.prompt_cache_key).toBe(cacheKey)
      },
    )

    test.each([
      { authType: "authorization", baseUrl: "https://api.x.ai" },
      { authType: "authorization" },
      { authType: "x-api-key" },
      { name: "other-provider" },
      { baseUrl: "https://api.x.ai" },
      { baseUrl: "https://custom.example" },
      { baseUrl: "https://cli-chat-proxy.grok.com.evil.example" },
      { baseUrl: "http://cli-chat-proxy.grok.com" },
    ] satisfies Array<Partial<ResolvedProviderConfig>>)(
      "does not inject Grok headers for %j",
      async (overrides) => {
        const requests = captureRequests()
        const provider = createProvider(overrides)
        const payload: ResponsesPayload = {
          model: "other-model",
          input: "hello",
          prompt_cache_key: "original-cache-key",
        }
        await forward(payload, provider)
        const headers = new Headers(requests[0].init?.headers)
        for (const name of grokHeaderNames)
          expect(headers.has(name)).toBe(false)
        expect(requests[0].url).toBe(`${provider.baseUrl}/v1/responses`)
        expect(requests[0].init?.body).toBe(JSON.stringify(payload))
      },
    )
  })
}
