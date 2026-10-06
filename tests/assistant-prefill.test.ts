import { beforeEach, expect, mock, test } from "bun:test"

import {
  assistantPrefillState,
  withAssistantPrefillFallback,
} from "~/lib/assistant-prefill"
import { HTTPError } from "~/lib/error"

const chatCompletionsRejection = () =>
  new HTTPError(
    "Failed to create chat completions",
    Response.json(
      {
        error: {
          message:
            "This model does not support assistant message prefill. The conversation must end with a user message.",
          code: "invalid_request_body",
        },
      },
      { status: 400 },
    ),
  )

beforeEach(() => {
  assistantPrefillState.rejectingModels.clear()
})

test("retries once with the fallback applied when prefill is rejected", async () => {
  const applyFallback = mock(() => {})
  const run = mock(() => Promise.resolve("ok"))
  run.mockImplementationOnce(() => Promise.reject(chatCompletionsRejection()))

  const result = await withAssistantPrefillFallback({
    model: "no-prefill-model",
    endsOnAssistant: () => true,
    applyFallback,
    run,
  })

  expect(result).toBe("ok")
  expect(run).toHaveBeenCalledTimes(2)
  expect(applyFallback).toHaveBeenCalledTimes(1)
})

test("applies the fallback upfront once a model is known to reject prefill", async () => {
  assistantPrefillState.rejectingModels.add("no-prefill-model")
  const applyFallback = mock(() => {})
  const run = mock(() => Promise.resolve("ok"))

  await withAssistantPrefillFallback({
    model: "no-prefill-model",
    endsOnAssistant: () => true,
    applyFallback,
    run,
  })

  expect(run).toHaveBeenCalledTimes(1)
  expect(applyFallback).toHaveBeenCalledTimes(1)
})

test("never applies the fallback when the conversation ends on a user turn", async () => {
  assistantPrefillState.rejectingModels.add("no-prefill-model")
  const applyFallback = mock(() => {})

  await withAssistantPrefillFallback({
    model: "no-prefill-model",
    endsOnAssistant: () => false,
    applyFallback,
    run: () => Promise.resolve("ok"),
  })

  expect(applyFallback).not.toHaveBeenCalled()
})

test("rethrows unrelated errors without remembering the model", async () => {
  const error = new HTTPError(
    "Failed to create messages",
    Response.json({ error: { message: "bad request" } }, { status: 400 }),
  )

  const result = withAssistantPrefillFallback({
    model: "some-model",
    endsOnAssistant: () => true,
    applyFallback: () => {},
    run: () => Promise.reject(error),
  })

  const thrown = await result.catch((caught: unknown) => caught)
  expect(thrown).toBe(error)
  expect(assistantPrefillState.rejectingModels.has("some-model")).toBe(false)
  expect(await error.response.text()).toContain("bad request")
})
