import { afterEach, describe, expect, test } from "bun:test"

import type { AccountContext } from "../src/lib/types/account"

import { copilotBaseUrl, githubHeaders } from "../src/lib/api-config"

const initialOauthApp = process.env.COPILOT_API_OAUTH_APP
const initialEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL

const accountContext: AccountContext = {
  githubToken: "ghu_test",
  copilotToken: "copilot_test",
  accountType: "business",
  vsCodeVersion: "1.0.0",
}

afterEach(() => {
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

describe("copilotBaseUrl", () => {
  test("uses the account-specific Copilot endpoint when present", () => {
    delete process.env.COPILOT_API_OAUTH_APP
    delete process.env.COPILOT_API_ENTERPRISE_URL

    expect(
      copilotBaseUrl({
        ...accountContext,
        copilotApiUrl: "https://copilot-proxy.example.com",
      }),
    ).toBe("https://copilot-proxy.example.com")
  })

  test("prefers enterprise routing over the account-specific Copilot endpoint", () => {
    process.env.COPILOT_API_ENTERPRISE_URL = "ghe.example.com"

    expect(
      copilotBaseUrl({
        ...accountContext,
        copilotApiUrl: "https://copilot-proxy.example.com",
      }),
    ).toBe("https://copilot-api.ghe.example.com")
  })

  test("keeps opencode on the public Copilot endpoint", () => {
    process.env.COPILOT_API_OAUTH_APP = "opencode"

    expect(
      copilotBaseUrl({
        ...accountContext,
        copilotApiUrl: "https://copilot-proxy.example.com",
      }),
    ).toBe("https://api.githubcopilot.com")
  })
})

test("githubHeaders uses opencode bearer auth when configured", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers = githubHeaders(accountContext) as Record<string, string>

  expect(headers.Authorization).toBe("Bearer ghu_test")
  expect(headers["User-Agent"]).toContain("opencode/1.3.9")
})
