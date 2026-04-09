import { expect, test } from "bun:test"

import { fmtDurationSeconds } from "../src/lib/format"

test("fmtDurationSeconds renders milliseconds as seconds with one decimal", () => {
  expect(fmtDurationSeconds(0)).toBe("0.0")
  expect(fmtDurationSeconds(1534)).toBe("1.5")
  expect(fmtDurationSeconds(1999)).toBe("2.0")
  expect(fmtDurationSeconds(null)).toBe("")
  expect(fmtDurationSeconds(undefined)).toBe("")
})
