import { describe, expect, test } from "bun:test"

import type { AccountRuntime } from "../src/lib/types/account"

import { HTTPError } from "../src/lib/error"
import {
  computeDiff,
  extractErrorDetails,
  extractErrorObservability,
  shouldMarkAccountFailed,
  toAccountContext,
  truncate,
} from "../src/lib/handler-utils"

function createUnreadableResponse(status: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("body exploded"))
      },
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  )
}

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
  expect(details.ownershipMismatch).toBe(false)
})

describe("ownership mismatch 401 detection", () => {
  test("flags ownership mismatch when message contains 'does not belong to this connection'", () => {
    const error = new HTTPError(
      'input item ID "msg_abc" does not belong to this connection',
      new Response("", { status: 401 }),
    )

    const details = extractErrorDetails(error)

    expect(details.unauthorized).toBe(true)
    expect(details.ownershipMismatch).toBe(true)
    expect(details.httpStatus).toBe(401)
  })

  test("does not flag ownership mismatch for genuine unauthorized 401", () => {
    const error = new HTTPError(
      "Your token has expired",
      new Response("", { status: 401 }),
    )

    const details = extractErrorDetails(error)

    expect(details.unauthorized).toBe(true)
    expect(details.ownershipMismatch).toBe(false)
  })

  test("does not flag ownership mismatch for non-401 errors", () => {
    const error = new HTTPError("Not Found", new Response("", { status: 404 }))

    const details = extractErrorDetails(error)

    expect(details.unauthorized).toBe(false)
    expect(details.ownershipMismatch).toBe(false)
  })
})

describe("shouldMarkAccountFailed", () => {
  test("returns true for genuine unauthorized 401", () => {
    const details = extractErrorDetails(
      new HTTPError("Unauthorized", new Response("", { status: 401 })),
    )

    expect(shouldMarkAccountFailed(details)).toBe(true)
  })

  test("returns false for ownership mismatch 401", () => {
    const details = extractErrorDetails(
      new HTTPError(
        'input item ID "msg_abc" does not belong to this connection',
        new Response("", { status: 401 }),
      ),
    )

    expect(shouldMarkAccountFailed(details)).toBe(false)
  })

  test("returns false for non-401 errors", () => {
    const details = extractErrorDetails(
      new HTTPError("Server Error", new Response("", { status: 500 })),
    )

    expect(shouldMarkAccountFailed(details)).toBe(false)
  })
})

describe("extractErrorObservability", () => {
  test("extracts raw message from HTTPError response body", async () => {
    const body = JSON.stringify({
      error: { message: "something went wrong", code: "internal_error" },
    })
    const error = new HTTPError(
      "upstream failed",
      new Response(body, {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    )

    const obs = await extractErrorObservability(error)

    expect(obs.upstreamErrorMessageRaw).toBe(
      "something went wrong [code:internal_error]",
    )
    expect(obs.httpStatus).toBe(500)
    expect(obs.errorMessage).toBe("upstream failed")
  })

  test("sanitizes UUIDs and opaque IDs in raw message", async () => {
    const rawId = "11111111-1111-4111-8111-111111111111"
    const msgId = "msg_abc123xyz"
    const body = JSON.stringify({
      error: {
        message: `input item ID "${msgId}" in session ${rawId} not found`,
      },
    })
    const error = new HTTPError(
      "not found",
      new Response(body, { status: 404 }),
    )

    const obs = await extractErrorObservability(error)

    expect(obs.upstreamErrorMessageRaw).not.toContain(rawId)
    expect(obs.upstreamErrorMessageRaw).not.toContain(msgId)
    expect(obs.upstreamErrorMessageRaw).toContain("<uuid>")
    expect(obs.upstreamErrorMessageRaw).toContain("<opaque_id>")
  })

  test("does not mark account failed when 401 body cannot be read for ownership detection", async () => {
    const obs = await extractErrorObservability(
      new HTTPError("Unauthorized", createUnreadableResponse(401)),
    )

    expect(obs.unauthorized).toBe(true)
    expect(obs.ownershipMismatch).toBe(false)
    expect(obs.upstreamErrorMessageRaw).toBe("[upstream body read failed]")
    expect(obs.upstreamErrorMessageReadFailed).toBe(true)
    expect(shouldMarkAccountFailed(obs)).toBe(false)
  })

  test("detects ownership mismatch from response body when error message itself does not contain the pattern", async () => {
    const body = JSON.stringify({
      error: {
        message: 'input item ID "msg_abc" does not belong to this connection',
      },
    })
    const error = new HTTPError(
      "Unauthorized",
      new Response(body, { status: 401 }),
    )

    const obs = await extractErrorObservability(error)

    expect(obs.ownershipMismatch).toBe(true)
    expect(obs.unauthorized).toBe(true)
  })
})
