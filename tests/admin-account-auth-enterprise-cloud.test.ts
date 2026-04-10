import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

import type { AccountRegistry } from "../src/lib/types/account"

import { saveRegistry } from "../src/lib/accounts-registry"
import { ensurePaths, PATHS } from "../src/lib/paths"
import { authSessionManager } from "../src/routes/admin-api/auth-sessions"

const initialOauthApp = process.env.COPILOT_API_OAUTH_APP
const initialEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL
const originalStartAuth = authSessionManager.startAuth.bind(authSessionManager)

async function withRegistry(
  registry: AccountRegistry,
  run: () => Promise<void>,
): Promise<void> {
  const originalRegistry = await fs
    .readFile(PATHS.ACCOUNTS_REGISTRY_PATH, "utf8")
    .catch(() => null)

  await ensurePaths()
  await saveRegistry(registry)

  try {
    await run()
  } finally {
    if (originalRegistry === null) {
      await fs.rm(PATHS.ACCOUNTS_REGISTRY_PATH, { force: true })
    } else {
      await fs.mkdir(path.dirname(PATHS.ACCOUNTS_REGISTRY_PATH), {
        recursive: true,
      })
      await fs.writeFile(PATHS.ACCOUNTS_REGISTRY_PATH, originalRegistry, "utf8")
    }
  }
}

afterEach(() => {
  authSessionManager.startAuth = originalStartAuth

  if (initialOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = initialOauthApp
  }

  if (initialEnterpriseUrl === undefined) {
    delete process.env.COPILOT_API_ENTERPRISE_URL
  } else {
    process.env.COPILOT_API_ENTERPRISE_URL = initialEnterpriseUrl
  }
})

test("POST /api/admin/accounts/auth/start allows enterprise auth without a custom domain", async () => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL

  let receivedParams:
    | {
        accountType: string
        enterpriseDomain?: string
        reauthAccountId?: string
      }
    | undefined

  authSessionManager.startAuth = (params) => {
    receivedParams = params
    return Promise.resolve({
      sessionId: "session-enterprise-public",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    })
  }

  const { server } = await import("../src/server")

  const response = await server.fetch(
    new Request("http://localhost/api/admin/accounts/auth/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accountType: "enterprise",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(receivedParams).toEqual({
    accountType: "enterprise",
    enterpriseDomain: undefined,
  })
})

test("POST /api/admin/accounts/auth/start keeps a custom enterprise domain when provided", async () => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL

  let receivedParams:
    | {
        accountType: string
        enterpriseDomain?: string
        reauthAccountId?: string
      }
    | undefined

  authSessionManager.startAuth = (params) => {
    receivedParams = params
    return Promise.resolve({
      sessionId: "session-enterprise-custom-domain",
      userCode: "EFGH-5678",
      verificationUri: "https://ghe.example.com/login/device",
      expiresIn: 900,
      interval: 5,
    })
  }

  const { server } = await import("../src/server")

  const response = await server.fetch(
    new Request("http://localhost/api/admin/accounts/auth/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accountType: "enterprise",
        enterpriseDomain: "  ghe.example.com  ",
      }),
    }),
  )

  expect(response.status).toBe(200)
  expect(receivedParams).toEqual({
    accountType: "enterprise",
    enterpriseDomain: "ghe.example.com",
  })
})

test("POST /api/admin/accounts/:id/reauth allows enterprise accounts stored on the public domain", async () => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL

  await withRegistry(
    {
      version: 2,
      accounts: [
        {
          id: "octocat",
          accountType: "enterprise",
          addedAt: 1,
        },
      ],
      clientIdentities: {
        "public:default:octocat": {
          login: "octocat",
          oauthApp: "default",
          enterpriseDomain: "public",
          deviceId: "11111111-1111-4111-8111-111111111111",
          machineId:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          createdAt: 1,
        },
      },
    },
    async () => {
      let receivedParams:
        | {
            accountType: string
            enterpriseDomain?: string
            reauthAccountId?: string
          }
        | undefined

      authSessionManager.startAuth = (params) => {
        receivedParams = params
        return Promise.resolve({
          sessionId: "session-enterprise-reauth-public",
          userCode: "WXYZ-5678",
          verificationUri: "https://github.com/login/device",
          expiresIn: 900,
          interval: 5,
        })
      }

      const { server } = await import("../src/server")

      const response = await server.fetch(
        new Request("http://localhost/api/admin/accounts/octocat/reauth", {
          method: "POST",
        }),
      )

      expect(response.status).toBe(200)
      expect(receivedParams).toEqual({
        accountType: "enterprise",
        enterpriseDomain: undefined,
        reauthAccountId: "octocat",
      })
    },
  )
})
