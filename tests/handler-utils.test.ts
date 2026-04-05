import { expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import { HTTPError } from "../src/lib/error"
import {
  computeDiff,
  extractErrorDetails,
  toAccountContext,
  truncate,
} from "../src/lib/handler-utils"

test("truncate returns original when within limit", () => {
  expect(truncate("abc", 3)).toBe("abc")
  expect(truncate("abc", 10)).toBe("abc")
})

test("truncate appends ellipsis when exceeding limit", () => {
  expect(truncate("abcd", 3)).toBe("abc…")
})

test("computeDiff returns after-before for numbers", () => {
  expect(computeDiff(5, 8)).toBe(3)
})

test("computeDiff returns undefined if inputs are missing", () => {
  expect(computeDiff(undefined, 8)).toBeUndefined()
  expect(computeDiff(5, undefined)).toBeUndefined()
})

test("toAccountContext projects AccountRuntime to AccountContext", () => {
  const runtime: AccountRuntime = {
    id: "octocat",
    accountLogin: "octocat",
    accountType: "individual",
    addedAt: 0,
    githubToken: "ghp_test",
    copilotToken: "copilot_test",
    copilotApiUrl: "https://copilot.example.com",
    vsCodeVersion: "1.0.0",
    clientDeviceId: "11111111-1111-4111-8111-111111111111",
    clientMachineId:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    clientSessionId: "11111111-1111-4111-8111-1111111111111712345678901",
  }

  expect(toAccountContext(runtime)).toEqual({
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

test("extractErrorDetails handles non-HTTP errors", () => {
  const error = new Error("boom")
  const details = extractErrorDetails(error)

  expect(details.httpStatus).toBe(500)
  expect(details.errorStatus).toBeUndefined()
  expect(details.errorMessage).toBe("boom")
  expect(details.unauthorized).toBe(false)
})

test("extractErrorDetails handles HTTPError and detects unauthorized", () => {
  const error = new HTTPError(
    "nope",
    new Response("unauthorized", { status: 401 }),
  )

  const details = extractErrorDetails(error)

  expect(details.httpStatus).toBe(401)
  expect(details.errorStatus).toBe(401)
  expect(details.errorMessage).toBe("nope")
  expect(details.unauthorized).toBe(true)
})
