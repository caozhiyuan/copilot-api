import { describe, expect, mock, test } from "bun:test"

import {
  isXaiCredentialsExpired,
  loginXai,
  refreshXaiCredentials,
  XaiOAuthError,
  type XaiAuthInfo,
} from "~/lib/auth/oauth/xai"

const device = {
  device_code: "private-device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.x.ai/device",
  verification_uri_complete: "https://auth.x.ai/device?user_code=ABCD-EFGH",
  expires_in: 300,
  interval: 5,
}
const tokens = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
  id_token: `header.${Buffer.from(JSON.stringify({ sub: "xai-account" })).toString("base64url")}.signature`,
}
const credentials = {
  accountId: "xai-account",
  accessToken: "old-access-token",
  refreshToken: "old-refresh-token",
  expiresAt: 1,
}

async function expectRejected(
  promise: Promise<unknown>,
  expected?: string | Error,
): Promise<void> {
  const error: unknown = await promise.catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(Error)
  if (typeof expected === "string")
    expect((error as Error).message).toContain(expected)
  else if (expected) expect(error).toBe(expected)
}

function responses(...items: Array<Response>) {
  return mock((_url: string, _init: RequestInit) => {
    const response = items.shift()
    if (!response) throw new Error("Unexpected request")
    return Promise.resolve(response)
  })
}

describe("xAI device authorization", () => {
  test("uses OIDC userinfo for opaque tokens to identify the account", async () => {
    const fetcher = responses(
      Response.json(device),
      Response.json({ access_token: "opaque", refresh_token: "r" }),
      Response.json({ sub: "userinfo-account" }),
    )
    const result = await loginXai({ onAuth() {} }, { fetcher })
    expect(result.accountId).toBe("userinfo-account")
    expect(fetcher.mock.calls[2]?.[0]).toBe("https://auth.x.ai/oauth2/userinfo")
    expect(fetcher.mock.calls[2]?.[1].headers).toMatchObject({
      Authorization: "Bearer opaque",
    })
  })
  test("extracts account identity from the access token and rejects invalid userinfo", async () => {
    const access_token = `h.${Buffer.from(JSON.stringify({ sub: "access-account", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.s`
    const fetcher = responses(
      Response.json(device),
      Response.json({ access_token, refresh_token: "r" }),
    )
    expect((await loginXai({ onAuth() {} }, { fetcher })).accountId).toBe(
      "access-account",
    )
    for (const userinfo of [
      Response.json({ error: "unauthorized" }, { status: 401 }),
      Response.json({ sub: "" }),
    ]) {
      await expectRejected(
        loginXai(
          { onAuth() {} },
          {
            fetcher: responses(
              Response.json(device),
              Response.json({
                access_token: "opaque",
                refresh_token: "r",
                id_token: "invalid",
              }),
              userinfo,
            ),
          },
        ),
      )
    }
  })
  test("uses the reference client and scopes and publishes only public authorization info", async () => {
    const fetcher = responses(Response.json(device), Response.json(tokens))
    const onAuth = mock((_info: XaiAuthInfo) => {})
    const before = Date.now()
    const result = await loginXai({ onAuth }, { fetcher })
    expect(result).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    })
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(onAuth.mock.calls[0]?.[0]).toMatchObject({
      url: device.verification_uri_complete,
      verificationUri: device.verification_uri,
      userCode: device.user_code,
    })
    expect(JSON.stringify(onAuth.mock.calls)).not.toContain(device.device_code)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe("https://auth.x.ai/oauth2/device/code")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    })
    const form = new URLSearchParams(init.body as URLSearchParams)
    expect(form.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828")
    expect(form.get("scope")).toBe(
      "openid profile email offline_access grok-cli:access api:access",
    )
    expect(form.get("referrer")).toBe("opencode")
    const poll = new URLSearchParams(
      fetcher.mock.calls[1][1].body as URLSearchParams,
    )
    expect(poll.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code",
    )
    expect(poll.get("device_code")).toBe(device.device_code)
  })

  test("keeps polling pending authorization and permanently increases the interval on slow_down", async () => {
    const fetcher = responses(
      Response.json({ ...device, verification_uri_complete: undefined }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json(tokens),
    )
    const sleep = mock((_ms: number, _signal: AbortSignal) => Promise.resolve())
    const onAuth = mock((_info: XaiAuthInfo) => {})
    await loginXai({ onAuth }, { fetcher, sleep })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([8000, 13000, 13000])
    expect(onAuth.mock.calls[0]?.[0].url).toBe(device.verification_uri)
  })

  test.each(["access_denied", "authorization_denied", "expired_token"])(
    "stops polling for %s",
    async (error) => {
      const fetcher = responses(
        Response.json(device),
        Response.json({ error }, { status: 400 }),
      )
      const result = await loginXai({ onAuth() {} }, { fetcher }).catch(
        (cause: unknown) => cause,
      )
      expect(result).toBeInstanceOf(XaiOAuthError)
      expect((result as XaiOAuthError).reason).toBe(
        error === "expired_token" ?
          "authorization_expired"
        : "authorization_denied",
      )
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  test("does not log server error bodies or descriptions", async () => {
    const fetcher = responses(
      Response.json(
        { error: "invalid_client", error_description: "secret-token" },
        { status: 401 },
      ),
    )
    await expectRejected(
      loginXai({ onAuth() {} }, { fetcher }),
      "xAI authorization request failed (401): invalid_client",
    )
    const malformed = responses(
      Response.json(device),
      new Response("secret-token", { status: 502 }),
    )
    await expectRejected(
      loginXai({ onAuth() {} }, { fetcher: malformed }),
      "xAI authorization request failed (502)",
    )
  })

  test("rejects malformed device and token responses", async () => {
    await expectRejected(
      loginXai(
        { onAuth() {} },
        { fetcher: responses(Response.json({ ...device, device_code: "" })) },
      ),
    )
    await expectRejected(
      loginXai(
        { onAuth() {} },
        {
          fetcher: responses(
            Response.json(device),
            Response.json({ access_token: "a" }),
          ),
        },
      ),
      "missing refresh_token",
    )
    await expectRejected(
      loginXai(
        { onAuth() {} },
        {
          fetcher: responses(
            Response.json(device),
            Response.json({ ...tokens, access_token: "" }),
          ),
        },
      ),
    )
  })

  test("cancels before requesting a code or exchanging a token", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled")
    controller.abort(reason)
    const fetcher = responses()
    await expectRejected(
      loginXai({ signal: controller.signal, onAuth() {} }, { fetcher }),
      reason,
    )
    expect(fetcher).not.toHaveBeenCalled()
    const during = new AbortController()
    const requested = responses(Response.json(device))
    await expectRejected(
      loginXai(
        {
          signal: during.signal,
          onAuth() {
            during.abort(reason)
          },
        },
        { fetcher: requested },
      ),
      reason,
    )
    expect(requested).toHaveBeenCalledTimes(1)
  })

  test("cancels a pending polling delay without requesting another token", async () => {
    const controller = new AbortController()
    const fetcher = responses(
      Response.json(device),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
    )
    const reason = new Error("cancelled while waiting")
    const sleep = mock((_ms: number, signal: AbortSignal) => {
      controller.abort(reason)
      signal.throwIfAborted()
      return Promise.resolve()
    })
    await expectRejected(
      loginXai({ onAuth() {}, signal: controller.signal }, { fetcher, sleep }),
      reason,
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test("enforces expiry during a pending poll and uses default polling values", async () => {
    const fetcher = responses(
      Response.json({ ...device, expires_in: 0.001, interval: 0 }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
    )
    await expectRejected(
      loginXai({ onAuth() {} }, { fetcher }),
      "xAI device code expired",
    )
  })

  test("enforces a minimum one-second polling interval", async () => {
    const fetcher = responses(
      Response.json({ ...device, interval: 0.01, expires_in: undefined }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json(tokens),
    )
    const sleep = mock((_ms: number, _signal: AbortSignal) => Promise.resolve())
    await loginXai({ onAuth() {} }, { fetcher, sleep })
    expect(sleep.mock.calls[0]?.[0]).toBe(4000)
  })
})

describe("xAI token refresh", () => {
  test("rejects a refresh response belonging to another account", async () => {
    const id_token = `h.${Buffer.from(JSON.stringify({ sub: "another-account" })).toString("base64url")}.s`
    await expectRejected(
      refreshXaiCredentials(
        credentials,
        {},
        { fetcher: responses(Response.json({ ...tokens, id_token })) },
      ),
      "different account",
    )
  })
  test("uses the refresh grant and keeps the old refresh token when no replacement is sent", async () => {
    const fetcher = responses(
      Response.json({ access_token: "new-access", expires_in: 3600 }),
    )
    const result = await refreshXaiCredentials(credentials, {}, { fetcher })
    expect(result.refreshToken).toBe(credentials.refreshToken)
    expect(result.accessToken).toBe("new-access")
    expect(
      new URLSearchParams(fetcher.mock.calls[0][1].body as URLSearchParams).get(
        "grant_type",
      ),
    ).toBe("refresh_token")
  })

  test("rotates refresh tokens and derives expiry from JWT claims when needed", async () => {
    const exp = Math.floor(Date.now() / 1000) + 7200
    const accessToken = `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`
    const fetcher = responses(
      Response.json({ access_token: accessToken, refresh_token: "rotated" }),
    )
    const result = await refreshXaiCredentials(credentials, {}, { fetcher })
    expect(result).toEqual({
      accountId: credentials.accountId,
      accessToken,
      refreshToken: "rotated",
      expiresAt: exp * 1000,
    })
  })

  test.each([
    "opaque",
    "header.invalid.sig",
    `header.${Buffer.from(JSON.stringify({ exp: "invalid" })).toString("base64url")}.sig`,
  ])("uses a one-hour fallback for %s", async (access_token) => {
    const before = Date.now()
    const result = await refreshXaiCredentials(
      credentials,
      {},
      { fetcher: responses(Response.json({ access_token, expires_in: 0 })) },
    )
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
  })

  test("reports refresh failures and timeouts", async () => {
    await expectRejected(
      refreshXaiCredentials(
        credentials,
        {},
        {
          fetcher: responses(
            Response.json({ error: "invalid_grant" }, { status: 400 }),
          ),
        },
      ),
      "invalid_grant",
    )
    const fetcher = mock(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          )
        }),
    )
    await expectRejected(
      refreshXaiCredentials(credentials, { timeoutMs: 1 }, { fetcher }),
      "timed out",
    )
    const failure = new Error("network unavailable")
    await expectRejected(
      refreshXaiCredentials(
        credentials,
        {},
        { fetcher: () => Promise.reject(failure) },
      ),
      failure,
    )
  })

  test("refreshes within one minute of expiry", () => {
    expect(isXaiCredentialsExpired({ expiresAt: 60_000 }, 0)).toBe(true)
    expect(isXaiCredentialsExpired({ expiresAt: 60_001 }, 0)).toBe(false)
  })
})
