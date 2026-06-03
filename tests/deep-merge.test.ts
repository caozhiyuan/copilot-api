import { describe, expect, test } from "bun:test"

import { deepMerge } from "../src/lib/deep-merge"

describe("deepMerge", () => {
  test("merges nested objects recursively", () => {
    const target = {
      capabilities: {
        limits: { max_output_tokens: 100, max_prompt_tokens: 200 },
      },
    }
    const source = { capabilities: { limits: { max_output_tokens: 999 } } }

    expect(deepMerge(target, source)).toEqual({
      capabilities: {
        limits: { max_output_tokens: 999, max_prompt_tokens: 200 },
      },
    })
  })

  test("replaces arrays instead of merging them", () => {
    const target = { supported_endpoints: ["/v1/messages", "/responses"] }
    const source = { supported_endpoints: ["/responses"] }

    expect(deepMerge(target, source)).toEqual({
      supported_endpoints: ["/responses"],
    })
  })

  test("replaces primitives and null", () => {
    expect(
      deepMerge<Record<string, unknown>>({ a: 1, b: 2 }, { a: 5, b: null }),
    ).toEqual({
      a: 5,
      b: null,
    })
  })

  test("replaces when types mismatch", () => {
    expect(
      deepMerge<Record<string, unknown>>(
        { a: { nested: true } },
        { a: "scalar" },
      ),
    ).toEqual({
      a: "scalar",
    })
  })

  test("does not mutate the inputs", () => {
    const target = { capabilities: { limits: { max_output_tokens: 100 } } }
    const source = { capabilities: { limits: { max_output_tokens: 999 } } }

    deepMerge(target, source)

    expect(target.capabilities.limits.max_output_tokens).toBe(100)
    expect(source.capabilities.limits.max_output_tokens).toBe(999)
  })

  test("adds new keys from source", () => {
    expect(deepMerge<Record<string, unknown>>({ a: 1 }, { b: 2 })).toEqual({
      a: 1,
      b: 2,
    })
  })
})
