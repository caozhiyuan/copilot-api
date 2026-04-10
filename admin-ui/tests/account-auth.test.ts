import { expect, test } from "bun:test"

import {
  buildAccountAuthRequest,
  cleanEnterpriseDomain,
} from "../src/lib/account-auth"

test("cleanEnterpriseDomain strips protocol and trailing slashes", () => {
  expect(cleanEnterpriseDomain(" https://ghe.example.com/ ")).toBe(
    "ghe.example.com",
  )
})

test("buildAccountAuthRequest allows enterprise accounts without custom domain", () => {
  expect(
    buildAccountAuthRequest({
      accountType: "enterprise",
      enterpriseDomain: "   ",
    }),
  ).toEqual({
    accountType: "enterprise",
    enterpriseDomain: undefined,
  })
})

test("buildAccountAuthRequest keeps custom enterprise domains when present", () => {
  expect(
    buildAccountAuthRequest({
      accountType: "enterprise",
      enterpriseDomain: "https://ghe.example.com/",
    }),
  ).toEqual({
    accountType: "enterprise",
    enterpriseDomain: "ghe.example.com",
  })
})

test("buildAccountAuthRequest ignores custom domains for non-enterprise accounts", () => {
  expect(
    buildAccountAuthRequest({
      accountType: "business",
      enterpriseDomain: "https://ghe.example.com/",
    }),
  ).toEqual({
    accountType: "business",
    enterpriseDomain: undefined,
  })
})
