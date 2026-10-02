import { expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { createEmbeddings } from "../src/services/copilot/create-embeddings"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock((_url: string, opts: { body: string }) => ({
  ok: true,
  json: () => ({ object: "list", data: [], model: "model-id" }),
  body: opts.body,
}))

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("normalizes a string input to a one-element array", async () => {
  await createEmbeddings({ input: "first text", model: "model-id" })

  const request = fetchMock.mock.calls[0][1] as { body: string }
  expect(JSON.parse(request.body)).toEqual({
    input: ["first text"],
    model: "model-id",
  })
})

test("preserves array inputs", async () => {
  await createEmbeddings({
    input: ["first text", "second text"],
    model: "model-id",
  })

  const request = fetchMock.mock.calls[1][1] as { body: string }
  expect(JSON.parse(request.body)).toEqual({
    input: ["first text", "second text"],
    model: "model-id",
  })
})
