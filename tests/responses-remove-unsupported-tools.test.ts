import { describe, expect, it } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { removeUnsupportedTools } from "~/routes/responses/handler"

const makePayload = (tools: ResponsesPayload["tools"]): ResponsesPayload =>
  ({ model: "gpt-5", input: [], tools }) as unknown as ResponsesPayload

describe("removeUnsupportedTools", () => {
  it("removes image_generation tools", () => {
    const payload = makePayload([
      { type: "image_generation" },
      { type: "function", name: "foo" },
    ] as ResponsesPayload["tools"])

    removeUnsupportedTools(payload)

    expect(payload.tools).toHaveLength(1)
    expect((payload.tools as Array<{ type: string }>)[0].type).toBe("function")
  })

  it("leaves payload unchanged when no unsupported tools present", () => {
    const tools = [
      { type: "function", name: "foo" },
      { type: "web_search" },
    ] as ResponsesPayload["tools"]
    const payload = makePayload(tools)

    removeUnsupportedTools(payload)

    expect(payload.tools).toHaveLength(2)
  })

  it("is a no-op when tools is missing or empty", () => {
    const empty = makePayload([] as ResponsesPayload["tools"])
    removeUnsupportedTools(empty)
    expect(empty.tools).toEqual([] as ResponsesPayload["tools"])

    const missing = { model: "gpt-5", input: [] } as unknown as ResponsesPayload
    removeUnsupportedTools(missing)
    expect(missing.tools).toBeUndefined()
  })
})
