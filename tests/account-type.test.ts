import { expect, test } from "bun:test"

import { parseAccountType } from "../src/lib/types/account"

test("parseAccountType accepts valid account types", () => {
  expect(parseAccountType("individual")).toBe("individual")
  expect(parseAccountType("business")).toBe("business")
  expect(parseAccountType("enterprise")).toBe("enterprise")
})

test("parseAccountType rejects invalid account types", () => {
  expect(() => parseAccountType("foo")).toThrow(
    /Invalid account type: foo\. Valid values: individual, business, enterprise/,
  )
})
