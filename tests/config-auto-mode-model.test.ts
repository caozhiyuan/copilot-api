import { afterEach, expect, test } from "bun:test"

import { getAutoModeModel } from "../src/lib/config"

const originalAutoModeModel = process.env.AUTO_MODE_MODEL

afterEach(() => {
  if (originalAutoModeModel === undefined) {
    delete process.env.AUTO_MODE_MODEL
    return
  }
  process.env.AUTO_MODE_MODEL = originalAutoModeModel
})

test("getAutoModeModel returns undefined when unset", () => {
  delete process.env.AUTO_MODE_MODEL
  expect(getAutoModeModel()).toBeUndefined()
})

test("getAutoModeModel returns the trimmed value when set", () => {
  process.env.AUTO_MODE_MODEL = "  gpt-5.6-luna  "
  expect(getAutoModeModel()).toBe("gpt-5.6-luna")
})

test("getAutoModeModel returns undefined for an empty string", () => {
  process.env.AUTO_MODE_MODEL = ""
  expect(getAutoModeModel()).toBeUndefined()
})

test("getAutoModeModel returns undefined for a whitespace-only value", () => {
  process.env.AUTO_MODE_MODEL = "   "
  expect(getAutoModeModel()).toBeUndefined()
})
