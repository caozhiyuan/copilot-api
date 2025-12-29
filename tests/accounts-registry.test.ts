import { expect, test } from "bun:test"
import fs from "node:fs/promises"

import {
  hasRegistry,
  loadRegistry,
  validateAccountId,
} from "../src/lib/accounts-registry"

type ReadFile = typeof fs.readFile

const withMockedReadFile = async <T>(
  impl: ReadFile,
  run: () => Promise<T>,
): Promise<T> => {
  const original = fs.readFile
  ;(fs as unknown as { readFile: ReadFile }).readFile = impl
  try {
    return await run()
  } finally {
    ;(fs as unknown as { readFile: ReadFile }).readFile = original
  }
}

test("validateAccountId follows GitHub login rules", () => {
  // valid
  expect(validateAccountId("octocat")).toBe(true)
  expect(validateAccountId("a-1")).toBe(true)
  expect(validateAccountId("A1")).toBe(true)

  // invalid
  expect(validateAccountId("a_b")).toBe(false)
  expect(validateAccountId("-abc")).toBe(false)
  expect(validateAccountId("abc-")).toBe(false)
  expect(validateAccountId("a--b")).toBe(false)
  expect(validateAccountId("a".repeat(40))).toBe(false)
})

test("loadRegistry returns empty registry on ENOENT", async () => {
  const registry = await withMockedReadFile(
    (() => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException
      err.code = "ENOENT"
      throw err
    }) as unknown as ReadFile,
    loadRegistry,
  )

  expect(registry).toEqual({ version: 1, accounts: [] })
})

test("loadRegistry returns empty registry on empty file", async () => {
  const registry = await withMockedReadFile(
    (() => "   \n") as unknown as ReadFile,
    loadRegistry,
  )

  expect(registry).toEqual({ version: 1, accounts: [] })
})

test("loadRegistry throws on invalid JSON", async () => {
  try {
    await withMockedReadFile((() => "{") as unknown as ReadFile, loadRegistry)
    throw new Error("Expected loadRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/Invalid accounts registry JSON at/)
  }
})

test("loadRegistry throws on schema validation errors", async () => {
  const content = JSON.stringify({
    version: 1,
    accounts: [{ id: "octocat", accountType: "foo", addedAt: 1 }],
  })

  try {
    await withMockedReadFile(
      (() => content) as unknown as ReadFile,
      loadRegistry,
    )
    throw new Error("Expected loadRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/accounts\.0\.accountType/)
  }
})

test("loadRegistry throws on duplicate account ids", async () => {
  const content = JSON.stringify({
    version: 1,
    accounts: [
      { id: "octocat", accountType: "individual", addedAt: 1 },
      { id: "octocat", accountType: "business", addedAt: 2 },
    ],
  })

  try {
    await withMockedReadFile(
      (() => content) as unknown as ReadFile,
      loadRegistry,
    )
    throw new Error("Expected loadRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/duplicate account id "octocat"/)
  }
})

test("hasRegistry fails fast on invalid registry JSON", async () => {
  try {
    await withMockedReadFile((() => "{") as unknown as ReadFile, hasRegistry)
    throw new Error("Expected hasRegistry to throw")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(/Invalid accounts registry JSON at/)
  }
})
