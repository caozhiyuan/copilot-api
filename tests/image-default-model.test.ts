import { describe, expect, mock, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"
import {
  getDefaultImageModel,
  selectDefaultImageModel,
  type ImageProvider,
} from "~/lib/image-models"
import { resolveImageRequestModel } from "~/routes/images/default-model"

const codex = "codex/gpt-image-2"
const copilot = "github-copilot/gpt-image-2.5-flare"
const xai = "xai/grok-imagine-image-2.0"

function dependencies(available: Array<ImageProvider>) {
  return {
    isGitHubCopilotAvailable: mock(() => available.includes("github-copilot")),
    resolveProviderConfig: mock(
      (name: string): Promise<ResolvedProviderConfig | null> =>
        Promise.resolve(
          available.some((provider) => provider === name) ?
            {
              name,
              type: "openai-compatible",
              baseUrl: "https://provider.test",
              apiKey: "test-key",
              authType: "authorization",
            }
          : null,
        ),
    ),
  }
}

describe("default image models", () => {
  test.each([
    { ids: [xai, copilot, codex], expected: codex },
    { ids: [xai, copilot], expected: copilot },
    { ids: [xai], expected: xai },
    { ids: ["codex/gpt-6-sol"], expected: undefined },
    { ids: [], expected: undefined },
  ])("chooses $expected from the available image IDs", ({ ids, expected }) => {
    expect(selectDefaultImageModel(ids)).toBe(expected)
  })

  test("provides defaults only for the three supported image providers", () => {
    expect(getDefaultImageModel("codex")).toBe("gpt-image-2")
    expect(getDefaultImageModel("github-copilot")).toBe("gpt-image-2.5-flare")
    expect(getDefaultImageModel("xai")).toBe("grok-imagine-image-2.0")
    expect(getDefaultImageModel("custom")).toBeUndefined()
  })

  test.each([undefined, "", "  ", "gpt-image-2", " gpt-image-2 "])(
    "automatically selects a provider for model %s",
    async (requested) => {
      expect(
        await resolveImageRequestModel(
          requested,
          dependencies(["github-copilot", "xai"]),
        ),
      ).toBe(copilot)
    },
  )

  test.each([
    { available: ["codex", "github-copilot", "xai"], expected: codex },
    { available: ["github-copilot", "xai"], expected: copilot },
    { available: ["xai"], expected: xai },
  ] satisfies Array<{ available: Array<ImageProvider>; expected: string }>)(
    "uses provider priority for $available",
    async ({ available, expected }) => {
      expect(
        await resolveImageRequestModel(undefined, dependencies(available)),
      ).toBe(expected)
    },
  )

  test.each([
    { requested: codex, expected: codex },
    { requested: copilot, expected: copilot },
    { requested: "gpt-image-2.5-flare", expected: copilot },
    { requested: "grok-imagine-image-2.0", expected: xai },
    { requested: xai, expected: xai },
    { requested: "gpt-image-1", expected: "codex/gpt-image-1" },
    { requested: "future-image-model", expected: "codex/future-image-model" },
    { requested: "codex/future-image", expected: "codex/future-image" },
    {
      requested: "github-copilot/future-image",
      expected: "github-copilot/future-image",
    },
    { requested: "xai/future-image", expected: "xai/future-image" },
    {
      requested: "openrouter/black-forest-labs/flux-1.1-pro",
      expected: "openrouter/black-forest-labs/flux-1.1-pro",
    },
    { requested: " custom / future-image ", expected: "custom/future-image" },
  ])(
    "preserves explicit model $requested without probing other providers",
    async ({ requested, expected }) => {
      const options = dependencies([])
      expect(await resolveImageRequestModel(requested, options)).toBe(expected)
      expect(options.resolveProviderConfig).not.toHaveBeenCalled()
      expect(options.isGitHubCopilotAvailable).not.toHaveBeenCalled()
    },
  )

  test("probes providers in priority order only for an automatic selection", async () => {
    const options = dependencies(["github-copilot", "xai"])
    expect(await resolveImageRequestModel("gpt-image-2", options)).toBe(copilot)
    expect(
      options.resolveProviderConfig.mock.calls.map(([name]) => name),
    ).toEqual(["codex"])
    expect(options.isGitHubCopilotAvailable).toHaveBeenCalledTimes(1)
  })

  test("returns a clear error when no default provider is available", async () => {
    try {
      await resolveImageRequestModel(undefined, dependencies([]))
      throw new Error("Expected no provider error")
    } catch (error) {
      expect(error).toHaveProperty("response.status", 404)
      expect(error).toHaveProperty(
        "message",
        "No enabled image provider is available",
      )
    }
  })
})
