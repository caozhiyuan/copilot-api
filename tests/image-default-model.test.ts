import { describe, expect, mock, test } from "bun:test"

import type { ResolvedProviderConfig } from "~/lib/config"
import {
  DEFAULT_IMAGE_MODELS,
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
    isGitHubCopilotAvailable: () => available.includes("github-copilot"),
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

  test.each([undefined, "", "  ", "not-a-model", "custom/missing"])(
    "defaults missing or unsupported model %s to the first available provider",
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

  test.each(["codex", "github-copilot", "xai"] as const)(
    "keeps scoped requests on %s",
    async (provider) => {
      const options = { ...dependencies([]), provider }
      for (const requested of [undefined, "", "unsupported-model"]) {
        expect(await resolveImageRequestModel(requested, options)).toBe(
          DEFAULT_IMAGE_MODELS[provider],
        )
      }
      expect(options.resolveProviderConfig).not.toHaveBeenCalled()
    },
  )

  test.each([
    { requested: "gpt-image-2", expected: codex },
    { requested: copilot, expected: copilot },
    { requested: "gpt-image-2.5-flare", expected: copilot },
    { requested: "grok-imagine-image-2.0", expected: xai },
    { requested: xai, expected: xai },
  ])(
    "preserves supported model $requested when its provider is available",
    async ({ requested, expected }) => {
      expect(
        await resolveImageRequestModel(
          requested,
          dependencies(["codex", "github-copilot", "xai"]),
        ),
      ).toBe(expected)
    },
  )

  test("falls back when the explicitly selected provider is unavailable", async () => {
    const options = dependencies(["github-copilot", "xai"])
    expect(await resolveImageRequestModel(codex, options)).toBe(copilot)
    expect(
      options.resolveProviderConfig.mock.calls.map(([name]) => name),
    ).toEqual(["codex"])
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
