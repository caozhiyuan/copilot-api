import { afterEach, expect, test } from "bun:test"

import {
  buildIdentityKey,
  createAccountDeviceId,
  createAccountMachineId,
  createAccountSessionId,
  getCurrentIdentityEnvironment,
} from "../src/lib/account-client-identity"

const initialOauthApp = process.env.COPILOT_API_OAUTH_APP
const initialEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL

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

test("createAccountDeviceId matches the persisted VS Code device ID format", () => {
  expect(createAccountDeviceId()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  )
})

test("createAccountMachineId matches the current machine ID format", () => {
  expect(createAccountMachineId()).toMatch(/^[0-9a-f]{64}$/u)
})

test("createAccountSessionId matches the current runtime session format", () => {
  expect(createAccountSessionId()).toMatch(/^[0-9a-f-]{36}\d{13}$/u)
})

test("getCurrentIdentityEnvironment normalizes oauth app and enterprise domain", () => {
  process.env.COPILOT_API_OAUTH_APP = " OpenCode "
  process.env.COPILOT_API_ENTERPRISE_URL = "https://GHE.EXAMPLE.COM/"

  expect(getCurrentIdentityEnvironment()).toEqual({
    oauthApp: "opencode",
    enterpriseDomain: "ghe.example.com",
  })
})

test("buildIdentityKey namespaces login by environment", () => {
  expect(
    buildIdentityKey({
      login: "octocat",
      oauthApp: "default",
      enterpriseDomain: "public",
    }),
  ).toBe("public:default:octocat")
})
