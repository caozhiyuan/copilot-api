import { describe, expect, test } from "bun:test"

import { resolveSupportedReasoningEffort } from "~/lib/catalog/reasoning-effort"

describe("resolveSupportedReasoningEffort", () => {
  test("keeps the requested effort when it is supported", () => {
    expect(
      resolveSupportedReasoningEffort("high", ["low", "medium", "high"]),
    ).toBe("high")
    expect(resolveSupportedReasoningEffort("max", ["low", "max"])).toBe("max")
  })

  test("maps ultra to max when max is supported", () => {
    expect(
      resolveSupportedReasoningEffort("ultra", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toBe("max")
  })

  test("falls back to the highest supported level when max is unsupported", () => {
    expect(
      resolveSupportedReasoningEffort("max", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ).toBe("xhigh")
    expect(
      resolveSupportedReasoningEffort("ultra", [
        "low",
        "medium",
        "high",
        "xhigh",
      ]),
    ).toBe("xhigh")
  })

  test("preserves valid wire efforts when capabilities are unknown", () => {
    expect(resolveSupportedReasoningEffort("none", undefined)).toBe("none")
    expect(resolveSupportedReasoningEffort("minimal", [])).toBe("minimal")
    expect(resolveSupportedReasoningEffort("low", undefined)).toBe("low")
    expect(resolveSupportedReasoningEffort("max", [])).toBe("max")
  })

  test("maps ultra to max when capabilities are unknown", () => {
    expect(resolveSupportedReasoningEffort("ultra", undefined)).toBe("max")
    expect(resolveSupportedReasoningEffort("ultra", [])).toBe("max")
  })

  test("leaves unknown efforts unresolved for upstream validation", () => {
    expect(resolveSupportedReasoningEffort("turbo", undefined)).toBeUndefined()
    expect(
      resolveSupportedReasoningEffort("turbo", ["medium", "high"]),
    ).toBeUndefined()
  })

  test("maps minimal to low when minimal is unsupported", () => {
    expect(
      resolveSupportedReasoningEffort("minimal", ["low", "medium", "high"]),
    ).toBe("low")
  })

  test("clamps requests below all supported levels to the lowest supported", () => {
    expect(
      resolveSupportedReasoningEffort("none", ["low", "medium", "high"]),
    ).toBe("low")
  })

  test("ignores unknown levels in the supported list", () => {
    expect(resolveSupportedReasoningEffort("max", ["ultra", "high"])).toBe(
      "high",
    )
  })
})
