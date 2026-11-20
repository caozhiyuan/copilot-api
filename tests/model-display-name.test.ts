import { describe, expect, test } from "bun:test"

import { withModelDisplayName } from "~/lib/catalog/model-display-name"

describe("model display names", () => {
  test.each([
    { model: { id: "model", name: "Model name" }, displayName: "Model name" },
    { model: { id: "model" }, displayName: "model" },
    { model: { id: "model", name: " " }, displayName: "model" },
    {
      model: { id: "model", name: "Other", display_name: "Upstream label" },
      displayName: "Upstream label",
    },
    {
      model: { id: "model", name: "Other", display_name: "" },
      displayName: "",
    },
    {
      model: { id: "model", name: "Other", display_name: null },
      displayName: null,
    },
  ])("adds only missing display_name for %j", ({ model, displayName }) => {
    const original = structuredClone(model)
    const labeledModel: {
      id: string
      name?: string
      display_name?: string | null
    } = withModelDisplayName(model)
    expect(labeledModel).toEqual({
      ...model,
      display_name: displayName,
    })
    expect(model).toEqual(original)
  })

  test.each([
    { model: null },
    { model: undefined },
    { model: "invalid" },
    { model: 42 },
    { model: ["model"] },
  ])("keeps non-record upstream entries unchanged: %j", ({ model }) => {
    expect(withModelDisplayName(model)).toBe(model)
  })

  test.each([
    {
      model: { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
      provider: "opencode-go",
      expected: "GLM-5.3-Flash (opencode-go)",
    },
    { model: { id: "model" }, provider: "custom", expected: "model (custom)" },
    {
      model: { id: "model", name: "Other", display_name: "Upstream label" },
      provider: "custom",
      expected: "Upstream label (custom)",
    },
    {
      model: { id: "model", display_name: "Upstream label (custom)" },
      provider: "custom",
      expected: "Upstream label (custom)",
    },
    {
      model: { id: "model", display_name: "custom Upstream label" },
      provider: "custom",
      expected: "custom Upstream label",
    },
    {
      model: { id: "model", display_name: "Upstream label (other)" },
      provider: "custom",
      expected: "Upstream label (other) (custom)",
    },
    {
      model: { id: "model", display_name: "Upstream label" },
      provider: " custom ",
      expected: "Upstream label (custom)",
    },
    {
      model: { id: "model", display_name: "Upstream label" },
      provider: " ",
      expected: "Upstream label",
    },
    {
      model: { id: "model", display_name: "" },
      provider: "custom",
      expected: "",
    },
    {
      model: { id: "model", display_name: null },
      provider: "custom",
      expected: null,
    },
  ])(
    "identifies provider $provider without replacing the upstream label: %j",
    ({ model, provider, expected }) => {
      const original = structuredClone(model)
      const labeled: {
        id: string
        name?: string
        display_name?: string | null
      } = withModelDisplayName(model, provider)
      expect(labeled.display_name).toBe(expected)
      expect(model).toEqual(original)
      expect(withModelDisplayName(labeled, provider)).toBe(labeled)
    },
  )
})
