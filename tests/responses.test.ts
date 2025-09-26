import { describe, expect, test } from "bun:test"

import { createResponses } from "~/services/copilot/create-responses"

describe("Responses service test", () => {
  test("createResponses function should be defined", () => {
    expect(createResponses).toBeDefined()
    expect(typeof createResponses).toBe("function")
  })
})
