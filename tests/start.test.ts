import { describe, expect, test } from "bun:test"

import { selectClaudeCodeModel } from "~/start"

describe("Claude Code model selection", () => {
  test("ignores allowed models without a language-generation endpoint", () => {
    expect(
      selectClaudeCodeModel([
        {
          id: "text-embedding-3-large",
          supported_endpoints: ["/v1/embeddings"],
        },
        {
          id: "omni-moderation-latest",
          supported_endpoints: ["/v1/moderations"],
        },
        { id: "mai-1-preview", supported_endpoints: ["/responses"] },
      ]),
    ).toBe("mai-1-preview")
  })

  test("prefers an eligible GPT model", () => {
    expect(
      selectClaudeCodeModel([
        { id: "mai-1-preview", supported_endpoints: ["/v1/messages"] },
        { id: "gpt-5.4", supported_endpoints: ["ws:/responses"] },
      ]),
    ).toBe("gpt-5.4")
  })

  test("rejects shell syntax in remotely supplied model IDs", () => {
    expect(
      selectClaudeCodeModel([
        {
          id: "gpt-5;touch${IFS}/tmp/pwn",
          supported_endpoints: ["/responses"],
        },
        { id: "mai-1-preview", supported_endpoints: ["/responses"] },
      ]),
    ).toBe("mai-1-preview")
  })

  test("returns undefined without an eligible model", () => {
    expect(
      selectClaudeCodeModel([
        {
          id: "text-embedding-3-small",
          supported_endpoints: ["/v1/embeddings"],
        },
        { id: "claude-sonnet-4", supported_endpoints: ["/v1/messages"] },
      ]),
    ).toBeUndefined()
  })
})
