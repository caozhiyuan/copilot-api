import { expect, test } from "bun:test"

import { getUserVisibleErrorMessage } from "../src/lib/handler-utils"

test("prefers upstream error message when it is safe to expose", () => {
  expect(
    getUserVisibleErrorMessage({
      errorMessage: "Unauthorized",
      upstreamErrorMessageRaw:
        'input item ID "<opaque_id>" does not belong to this connection',
    }),
  ).toBe('input item ID "<opaque_id>" does not belong to this connection')
})

test("falls back to generic error message when upstream body read failed", () => {
  expect(
    getUserVisibleErrorMessage({
      errorMessage: "Unauthorized",
      upstreamErrorMessageRaw: "[upstream body read failed]",
      upstreamErrorMessageReadFailed: true,
    }),
  ).toBe("Unauthorized")
})

test("falls back to generic error message when no upstream message exists", () => {
  expect(
    getUserVisibleErrorMessage({
      errorMessage: "stream exploded",
    }),
  ).toBe("stream exploded")
})
