import { describe, expect, test } from "bun:test"

import {
  resolveTokenUsageCost,
  type TokenUsageCostInput,
} from "~/lib/token-usage/pricing"

const usage: TokenUsageCostInput = {
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 40,
  input_tokens: 100,
  model: "gpt-6-astra",
  output_tokens: 20,
  providerName: "codex",
  source: "provider",
}

describe("Codex service tier price estimates", () => {
  for (const { model, standardCost } of [
    { model: "gpt-6-astra", standardCost: 2_165_000 },
    { model: "gpt-6-sol", standardCost: 433_000 },
    { model: "gpt-6.1-sol", standardCost: 429_000 },
    { model: "gpt-6.1-terra", standardCost: 214_500 },
    { model: "gpt-6-luna", standardCost: 21_650 },
    { model: "codex-auto-review", standardCost: 21_650 },
    { model: "gpt-reserve", standardCost: 21_650 },
    { model: "gpt-5.6", standardCost: 866_000 },
    { model: "gpt-5.6-sol", standardCost: 866_000 },
    { model: "gpt-5.6-terra", standardCost: 473_000 },
    { model: "gpt-5.6-luna", standardCost: 47_300 },
  ]) {
    for (const { tier, multiplier } of [
      { tier: "default", multiplier: 1 },
      { tier: "priority", multiplier: 2 },
      { tier: "fast", multiplier: 2 },
      { tier: "ultrafast", multiplier: 6 },
    ]) {
      test(`${model} ${tier} prices input, output, and cache tokens`, () => {
        expect(
          resolveTokenUsageCost({ ...usage, model, serviceTier: tier }),
        ).toEqual({
          currency: "USD",
          source: "builtin",
          total_cost_nanos: standardCost * multiplier,
        })
      })
    }
  }

  test("applies the tier multiplier after long-context pricing", () => {
    expect(
      resolveTokenUsageCost({
        ...usage,
        input_tokens: 272_001,
        serviceTier: "ultrafast",
      }),
    ).toEqual({
      currency: "USD",
      source: "builtin",
      total_cost_nanos: 32_651_100_000,
    })
  })

  test("normalizes the provider, model, and tier names", () => {
    expect(
      resolveTokenUsageCost({
        ...usage,
        model: " GPT-6-ASTRA ",
        providerName: " CODEX ",
        serviceTier: " FAST ",
      })?.total_cost_nanos,
    ).toBe(4_330_000)
  })

  for (const tier of [undefined, null, "auto", "flex", "unknown", ""]) {
    test(`uses standard pricing for an unresolved tier ${String(tier)}`, () => {
      expect(
        resolveTokenUsageCost({ ...usage, serviceTier: tier })
          ?.total_cost_nanos,
      ).toBe(2_165_000)
    })
  }

  for (const { model, providerName, expectedCost } of [
    { model: "gpt-5.5", providerName: "codex", expectedCost: 200_000 },
    { model: "gpt-5.60", providerName: "codex", expectedCost: 200_000 },
    { model: "gpt-60", providerName: "codex", expectedCost: 200_000 },
    { model: "gpt-6-astra", providerName: "openai", expectedCost: 100_000 },
  ]) {
    test(`uses the provider to decide Fast pricing for ${providerName}/${model}`, () => {
      expect(
        resolveTokenUsageCost({
          ...usage,
          model,
          pricing: { input: 1 },
          pricingCurrency: "USD",
          providerName,
          serviceTier: "fast",
        })?.total_cost_nanos,
      ).toBe(expectedCost)
    })
  }

  test("applies service tiers to configured standard prices", () => {
    expect(
      resolveTokenUsageCost({
        ...usage,
        pricing: { input: 1, output: 2 },
        serviceTier: "priority",
      }),
    ).toEqual({
      currency: "USD",
      source: "config",
      total_cost_nanos: 280_000,
    })
  })

  test("does not apply Ultrafast estimates to other providers", () => {
    expect(
      resolveTokenUsageCost({
        ...usage,
        pricing: { input: 1 },
        pricingCurrency: "USD",
        providerName: "openai",
        serviceTier: "ultrafast",
      })?.total_cost_nanos,
    ).toBe(100_000)
  })

  test("applies GPT-5.6 Sol Fast rates after the long-context boundary", () => {
    expect(
      resolveTokenUsageCost({
        ...usage,
        input_tokens: 272_001,
        model: "gpt-5.6",
        serviceTier: "fast",
      }),
    ).toEqual({
      currency: "USD",
      source: "builtin",
      total_cost_nanos: 4_353_480_000,
    })
  })
})
