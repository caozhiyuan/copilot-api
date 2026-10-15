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

describe("Google model thinking capabilities", () => {
  test("maps effort without requiring Anthropic thinking and normalizes unsupported levels", () => {
    expect(
      config("gemini-3.1-pro-preview", { output_config: { effort: "low" } }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "LOW" })
    expect(
      config("gemini-3.1-pro-preview", { output_config: { effort: "medium" } }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" })
    expect(
      config("gemini-3-pro-preview", { output_config: { effort: "medium" } }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "LOW" })
    expect(
      config("gemini-3.1-flash-image-preview", {
        output_config: { effort: "medium" },
      }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "MINIMAL" })
    expect(
      config("gemini-3-pro-image-preview", {
        output_config: { effort: "low" },
      }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" })
    for (const effort of ["high", "xhigh", "max"] as const)
      expect(
        config("models/gemini-4-argon", { output_config: { effort } }),
      ).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" })
  })

  test("uses budgets for Gemini 2.5 effort and clamps explicit budgets to supported ranges", () => {
    for (const [effort, thinkingBudget] of [
      ["low", 2048],
      ["medium", 8192],
      ["high", 16384],
      ["xhigh", 24576],
      ["max", 24576],
    ] as const) {
      expect(config("gemini-2.5-flash", { output_config: { effort } })).toEqual(
        { includeThoughts: true, thinkingBudget },
      )
    }
    expect(
      config("gemini-2.5-pro", { output_config: { effort: "max" } }),
    ).toEqual({ includeThoughts: true, thinkingBudget: 32768 })
    expect(
      config("gemini-2.5-pro", {
        thinking: { type: "enabled", budget_tokens: 0 },
      }),
    ).toEqual({ includeThoughts: true, thinkingBudget: 128 })
    expect(
      config("gemini-2.5-flash-lite-preview", {
        thinking: { type: "enabled", budget_tokens: 128 },
      }),
    ).toEqual({ includeThoughts: true, thinkingBudget: 512 })
    expect(
      config("gemini-2.5-flash", {
        thinking: { type: "enabled", budget_tokens: 50000 },
      }),
    ).toEqual({ includeThoughts: true, thinkingBudget: 24576 })
    expect(
      config("gemini-2.5-flash", {
        thinking: { type: "enabled", budget_tokens: -1 },
      }),
    ).toEqual({ includeThoughts: true, thinkingBudget: -1 })
  })

  test("uses the lowest valid setting when thinking cannot be disabled", () => {
    const disabled = {
      thinking: { type: "disabled", budget_tokens: 32000 },
      output_config: { effort: "max" },
    } as const
    expect(config("gemini-2.5-pro", disabled)).toEqual({
      includeThoughts: false,
      thinkingBudget: 128,
    })
    expect(config("gemini-2.5-flash", disabled)).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    })
    expect(config("gemini-2.5-flash-lite", disabled)).toEqual({
      includeThoughts: false,
      thinkingBudget: 0,
    })
    for (const model of [
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.7-flash",
      "gemini-3.8-flash",
      "gemini-4-argon",
    ])
      expect(config(model, disabled)).toEqual({
        includeThoughts: false,
        thinkingLevel: "LOW",
      })
    for (const model of [
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.6-flash",
      "gemini-3.1-flash-image-preview",
      "gemini-3.1-flash-lite-image-preview",
    ])
      expect(config(model, disabled)).toEqual({
        includeThoughts: false,
        thinkingLevel: "MINIMAL",
      })
    expect(config("gemini-3-pro-image-preview", disabled)).toEqual({
      includeThoughts: false,
      thinkingLevel: "HIGH",
    })
  })

  test("gives explicit budgets priority over effort and never mixes budget and level", () => {
    const options = {
      thinking: { type: "enabled", budget_tokens: 2048 },
      output_config: { effort: "high" },
    } as const
    expect(config("gemini-2.5-pro", options)).toEqual({
      includeThoughts: true,
      thinkingBudget: 2048,
    })
    expect(config("gemini-3.1-pro-preview", options)).toEqual({
      includeThoughts: true,
      thinkingLevel: "LOW",
    })
    expect(
      config("gemini-3.1-pro-preview", {
        ...options,
        thinking: { type: "enabled", budget_tokens: 8192 },
      }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" })
    expect(
      config("gemini-3.1-pro-preview", {
        ...options,
        thinking: { type: "enabled", budget_tokens: 16384 },
      }),
    ).toEqual({ includeThoughts: true, thinkingLevel: "HIGH" })
    expect(
      config("gemini-3.1-pro-preview", {
        ...options,
        thinking: { type: "enabled", budget_tokens: -1 },
      }),
    ).toEqual({ includeThoughts: true })
    expect(
      config("gemini-3.1-pro-preview", { thinking: { type: "adaptive" } }),
    ).toEqual({ includeThoughts: true })
  })

  test("keeps upstream defaults when no control is requested or capabilities are unknown", () => {
    expect(config("gemini-3.1-pro-preview")).toBeUndefined()
    for (const model of [
      "custom-alias",
      "gemini-2.0-flash",
      "gemini-2.5-flash-image",
      "gemini-9-unknown",
    ]) {
      expect(
        config(model, { output_config: { effort: "medium" } }),
      ).toBeUndefined()
      expect(config(model, { thinking: { type: "disabled" } })).toBeUndefined()
    }
  })
})
