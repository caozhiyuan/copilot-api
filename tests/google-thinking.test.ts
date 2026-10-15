import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/types/anthropic"
import { translateAnthropicToGoogle } from "~/routes/messages/google-translation"

function config(
  model: string,
  options: Partial<AnthropicMessagesPayload> = {},
) {
  return translateAnthropicToGoogle({
    model,
    max_tokens: 32768,
    messages: [{ role: "user", content: "solve this" }],
    ...options,
  }).generationConfig.thinkingConfig
}

describe("Google thinking for Gemini 3.8 Flash and 4.0+ text models", () => {
  test("maps effort without requiring Anthropic thinking", () => {
    for (const model of [
      "gemini-3.8-flash",
      "models/gemini-3.8-flash",
      "gemini-4-argon",
      "gemini-4.0-pro",
    ]) {
      for (const [effort, thinkingLevel] of [
        ["low", "LOW"],
        ["medium", "MEDIUM"],
        ["high", "HIGH"],
        ["xhigh", "HIGH"],
        ["max", "HIGH"],
      ] as const) {
        const result = config(model, { output_config: { effort } })
        expect(result).toEqual({ includeThoughts: true, thinkingLevel })
        expect(result).not.toHaveProperty("thinkingBudget")
      }
    }
  })

  test("recognizes later major/minor versions without maintaining a model-name list", () => {
    // Synthetic model IDs exercise version matching, not availability claims.
    for (const model of [
      "gemini-4.1-test",
      "gemini-5-test",
      "gemini-10.2-test",
    ]) {
      expect(config(model, { output_config: { effort: "medium" } })).toEqual({
        includeThoughts: true,
        thinkingLevel: "MEDIUM",
      })
    }
  })

  test("uses LOW when disabled and gives it priority over budget and effort", () => {
    for (const model of ["gemini-3.8-flash", "gemini-4-argon"]) {
      expect(
        config(model, {
          thinking: { type: "disabled", budget_tokens: 32000 },
          output_config: { effort: "max" },
        }),
      ).toEqual({ includeThoughts: false, thinkingLevel: "LOW" })
    }
  })

  test("maps Anthropic budgets to relative tiers with priority over effort", () => {
    for (const model of ["gemini-3.8-flash", "gemini-4-argon"]) {
      for (const [budget_tokens, thinkingLevel] of [
        [1024, "LOW"],
        [2048, "LOW"],
        [2049, "MEDIUM"],
        [8192, "MEDIUM"],
        [8193, "HIGH"],
        [32768, "HIGH"],
      ] as const) {
        const result = config(model, {
          thinking: { type: "enabled", budget_tokens },
          output_config: { effort: "high" },
        })
        expect(result).toEqual({ includeThoughts: true, thinkingLevel })
        expect(result).not.toHaveProperty("thinkingBudget")
      }
      expect(
        config(model, {
          thinking: { type: "enabled", budget_tokens: -1 },
          output_config: { effort: "low" },
        }),
      ).toEqual({ includeThoughts: true })
      expect(config(model, { thinking: { type: "adaptive" } })).toEqual({
        includeThoughts: true,
      })
    }
  })

  test("leaves upstream defaults alone outside the maintained text model scope", () => {
    expect(config("gemini-3.8-flash")).toBeUndefined()
    for (const model of [
      "custom-alias",
      "gemini-2.5-pro",
      "gemini-3.1-pro-preview",
      "gemini-3.7-flash",
      "gemini-3.9-flash",
      "gemini-3.8-flash-tts",
      "gemini-4-live",
      "gemini-4-image",
    ]) {
      expect(
        config(model, { output_config: { effort: "medium" } }),
      ).toBeUndefined()
      expect(config(model, { thinking: { type: "disabled" } })).toBeUndefined()
    }
  })
})
