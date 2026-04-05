import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import {
  isAuthSnapshotCurrent,
  takeAuthSnapshot,
  toAccountContextFromSnapshot,
} from "../src/lib/accounts-manager-auth"

test("toAccountContextFromSnapshot preserves account-scoped identity fields", () => {
  const account: AccountRuntime = {
    id: "octocat",
    accountLogin: "octocat",
    accountType: "individual",
    addedAt: 0,
    githubToken: "ghp_test",
    copilotApiUrl: "https://copilot.example.com",
    vsCodeVersion: "1.0.0",
    clientDeviceId: "11111111-1111-4111-8111-111111111111",
    clientMachineId:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clientSessionId: "11111111-1111-4111-8111-1111111111111712345678901",
  }

  const snapshot = takeAuthSnapshot(account)

  expect(
    toAccountContextFromSnapshot(account, snapshot, "copilot_test"),
  ).toEqual({
    accountLogin: "octocat",
    githubToken: "ghp_test",
    copilotToken: "copilot_test",
    copilotApiUrl: "https://copilot.example.com",
    accountType: "individual",
    vsCodeVersion: "1.0.0",
    clientDeviceId: "11111111-1111-4111-8111-111111111111",
    clientMachineId:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clientSessionId: "11111111-1111-4111-8111-1111111111111712345678901",
  })
})

test("auth snapshot remains current when only the session ID rotates", () => {
  const account: AccountRuntime = {
    id: "octocat",
    accountLogin: "octocat",
    accountType: "individual",
    addedAt: 0,
    githubToken: "ghp_test",
    clientSessionId: "session-1",
  }

  const snapshot = takeAuthSnapshot(account)
  account.clientSessionId = "session-2"

  expect(isAuthSnapshotCurrent(account, snapshot)).toBe(true)
})
