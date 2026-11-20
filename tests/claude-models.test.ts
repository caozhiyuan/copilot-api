import { describe, expect, test } from "bun:test"

import {
  fromClaudeDiscoveryModelId,
  isClaudeUserAgent,
  toClaudeDiscoveryModelId,
} from "~/lib/catalog/claude-models"

describe("Claude gateway model discovery", () => {
  test.each([
    { userAgent: undefined, expected: false },
    { userAgent: "", expected: false },
    { userAgent: "curl/8.0", expected: false },
    { userAgent: "opencode/1.0", expected: false },
    { userAgent: "codex-tui/0.160.0", expected: false },
    { userAgent: "claude-cli/2.1.258 (external, cli)", expected: true },
    {
      userAgent: "vscode_claude_code/2.1.258 (external, sdk-ts)",
      expected: true,
    },
    { userAgent: "Claude-Code/2.1.258", expected: true },
  ])(
    "recognizes user agent $userAgent as Claude: $expected",
    ({ userAgent, expected }) => {
      expect(isClaudeUserAgent(userAgent)).toBe(expected)
    },
  )

  test.each([
    ["glm-5.3-flash", "my-claude-glm-5.3-flash[1m]"],
    ["opencode-go/glm-5.3-flash", "opencode-go/my-claude-glm-5.3-flash[1m]"],
    ["gpt-6-luna", "my-claude-gpt-6-luna[1m]"],
    ["codex/gpt-6-luna", "codex/my-claude-gpt-6-luna[1m]"],
    [
      "openrouter/openai/gpt-6-luna",
      "openrouter/my-claude-openai/gpt-6-luna[1m]",
    ],
    [
      "contoso/family/glm-5.3-flash",
      "contoso/my-claude-family/glm-5.3-flash[1m]",
    ],
    ["claude-sonnet-4-6", "claude-sonnet-4-6[1m]"],
    ["claude-opus-4.8", "claude-opus-4.8[1m]"],
    ["custom/my-Claude-model", "custom/my-Claude-model[1m]"],
    [
      "openrouter/anthropic/claude-opus-4.8",
      "openrouter/anthropic/claude-opus-4.8[1m]",
    ],
    ["claude-provider/glm-5.3-flash", "claude-provider/glm-5.3-flash[1m]"],
  ])("round trips model %s through discovery ID %s", (modelId, discoveryId) => {
    expect(toClaudeDiscoveryModelId(modelId)).toBe(discoveryId)
    expect(fromClaudeDiscoveryModelId(discoveryId)).toBe(modelId)
  })

  test.each([
    ["gpt-6-luna[1m]", "my-claude-gpt-6-luna[1m]"],
    ["claude-opus-4.8[1m]", "claude-opus-4.8[1m]"],
    [
      "opencode-go/my-claude-glm-5.3-flash[1m]",
      "opencode-go/my-claude-glm-5.3-flash[1m]",
    ],
  ])("does not duplicate the context suffix on %s", (modelId, discoveryId) => {
    expect(toClaudeDiscoveryModelId(modelId)).toBe(discoveryId)
    expect(toClaudeDiscoveryModelId(discoveryId)).toBe(discoveryId)
  })

  test.each([
    "glm-5.3-flash",
    "opencode-go/glm-5.3-flash",
    "claude-sonnet-4-6",
    "custom/claude-opus-4.8",
    "custom/foo-my-claude-model",
    "openrouter/anthropic/claude-sonnet-4-6",
    "custom/model[200k]",
    "custom/model[1m]/version",
  ])("preserves unprefixed Messages model %s", (modelId) => {
    expect(fromClaudeDiscoveryModelId(modelId)).toBe(modelId)
  })

  test("does not duplicate or globally remove the compatibility prefix", () => {
    const modelId = "custom/my-claude-foo-my-claude-model"
    expect(toClaudeDiscoveryModelId(modelId)).toBe(`${modelId}[1m]`)
    expect(fromClaudeDiscoveryModelId(`${modelId}[1m]`)).toBe(
      "custom/foo-my-claude-model",
    )
  })

  test.each(["", "[1m]"])(
    "restores a provider-scoped discovery ID with a nested upstream namespace and suffix %s",
    (suffix) => {
      expect(
        fromClaudeDiscoveryModelId(`my-claude-openai/gpt-6-luna${suffix}`),
      ).toBe("openai/gpt-6-luna")
    },
  )
})
