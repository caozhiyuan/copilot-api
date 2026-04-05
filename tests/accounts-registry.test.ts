import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"

import { buildIdentityKey } from "../src/lib/account-client-identity"
import {
  ensureAccountClientIdentity,
  getAccountClientIdentity,
  hasRegistry,
  loadRegistry,
  validateAccountId,
} from "../src/lib/accounts-registry"

type ReadFile = typeof fs.readFile
type WriteFile = typeof fs.writeFile

const initialOauthApp = process.env.COPILOT_API_OAUTH_APP
const initialEnterpriseUrl = process.env.COPILOT_API_ENTERPRISE_URL

afterEach(() => {
  if (initialOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
  } else {
    process.env.COPILOT_API_OAUTH_APP = initialOauthApp
  }

  if (initialEnterpriseUrl === undefined) {
    delete process.env.COPILOT_API_ENTERPRISE_URL
  } else {
    process.env.COPILOT_API_ENTERPRISE_URL = initialEnterpriseUrl
  }
})

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

const withMockedFs = async <T>(
  impl: { readFile: ReadFile; writeFile: WriteFile },
  run: () => Promise<T>,
): Promise<T> => {
  const originalReadFile = fs.readFile
  const originalWriteFile = fs.writeFile
  ;(fs as unknown as { readFile: ReadFile }).readFile = impl.readFile
  ;(fs as unknown as { writeFile: WriteFile }).writeFile = impl.writeFile
  try {
    return await run()
  } finally {
    ;(fs as unknown as { readFile: ReadFile }).readFile = originalReadFile
    ;(fs as unknown as { writeFile: WriteFile }).writeFile = originalWriteFile
  }
}

const toWrittenString = (data: Parameters<WriteFile>[1]): string => {
  if (typeof data === "string") {
    return data
  }

  return data instanceof Uint8Array ? new TextDecoder().decode(data) : ""
}

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, reject, resolve }
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

  expect(registry).toEqual({ version: 2, accounts: [], clientIdentities: {} })
})

test("loadRegistry returns empty registry on empty file", async () => {
  const registry = await withMockedReadFile(
    (() => "   \n") as unknown as ReadFile,
    loadRegistry,
  )

  expect(registry).toEqual({ version: 2, accounts: [], clientIdentities: {} })
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

test("loadRegistry migrates version 1 registry and backfills client identities", async () => {
  delete process.env.COPILOT_API_OAUTH_APP
  delete process.env.COPILOT_API_ENTERPRISE_URL

  let storedContent = JSON.stringify({
    version: 1,
    accounts: [{ id: "octocat", accountType: "individual", addedAt: 1 }],
  })
  const writes: Array<string> = []

  const registry = await withMockedFs(
    {
      readFile: (() => Promise.resolve(storedContent)) as unknown as ReadFile,
      writeFile: ((
        _path: Parameters<WriteFile>[0],
        data: Parameters<WriteFile>[1],
      ) => {
        storedContent = toWrittenString(data)
        writes.push(storedContent)
        return Promise.resolve()
      }) as unknown as WriteFile,
    },
    loadRegistry,
  )

  const identityKey = "public:default:octocat"

  expect(registry.version).toBe(2)
  expect(registry.accounts).toEqual([
    { id: "octocat", accountType: "individual", addedAt: 1 },
  ])
  const clientIdentity = registry.clientIdentities[identityKey]
  expect(clientIdentity).toBeDefined()
  if (!clientIdentity) {
    throw new Error("Expected migrated client identity to exist")
  }
  expect(clientIdentity).toMatchObject({
    login: "octocat",
    oauthApp: "default",
    enterpriseDomain: "public",
  })
  expect(clientIdentity.deviceId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  )
  expect(clientIdentity.machineId).toMatch(/^[0-9a-f]{64}$/u)
  expect(writes).toHaveLength(1)
  expect(JSON.parse(storedContent)).toEqual(registry)
})

test("ensureAccountClientIdentity reuses existing identity for the same key", async () => {
  const identityKey = buildIdentityKey({
    login: "octocat",
    oauthApp: "default",
    enterpriseDomain: "public",
  })
  let storedContent = JSON.stringify({
    version: 2,
    accounts: [],
    clientIdentities: {},
  })
  let writeCount = 0

  await withMockedFs(
    {
      readFile: (() => Promise.resolve(storedContent)) as unknown as ReadFile,
      writeFile: ((
        _path: Parameters<WriteFile>[0],
        data: Parameters<WriteFile>[1],
      ) => {
        storedContent = toWrittenString(data)
        writeCount++
        return Promise.resolve()
      }) as unknown as WriteFile,
    },
    async () => {
      const created = await ensureAccountClientIdentity({
        identityKey,
        login: "octocat",
        oauthApp: "default",
        enterpriseDomain: "public",
      })
      const reused = await ensureAccountClientIdentity({
        identityKey,
        login: "octocat",
        oauthApp: "default",
        enterpriseDomain: "public",
      })
      const readBack = await getAccountClientIdentity(identityKey)

      expect(reused).toEqual(created)
      expect(readBack).toEqual(created)
      expect(writeCount).toBe(1)
    },
  )
})

test("ensureAccountClientIdentity deduplicates concurrent creation for the same key", async () => {
  const identityKey = buildIdentityKey({
    login: "octocat",
    oauthApp: "default",
    enterpriseDomain: "public",
  })
  let storedContent = JSON.stringify({
    version: 2,
    accounts: [],
    clientIdentities: {},
  })
  let readCount = 0
  let writeCount = 0
  const readDeferred = createDeferred<string>()

  await withMockedFs(
    {
      readFile: (() => {
        readCount++
        return readDeferred.promise
      }) as unknown as ReadFile,
      writeFile: ((
        _path: Parameters<WriteFile>[0],
        data: Parameters<WriteFile>[1],
      ) => {
        storedContent = toWrittenString(data)
        writeCount++
        return Promise.resolve()
      }) as unknown as WriteFile,
    },
    async () => {
      const first = ensureAccountClientIdentity({
        identityKey,
        login: "octocat",
        oauthApp: "default",
        enterpriseDomain: "public",
      })
      const second = ensureAccountClientIdentity({
        identityKey,
        login: "octocat",
        oauthApp: "default",
        enterpriseDomain: "public",
      })

      readDeferred.resolve(
        JSON.stringify({
          version: 2,
          accounts: [],
          clientIdentities: {},
        }),
      )

      const [created, reused] = await Promise.all([first, second])

      expect(created).toEqual(reused)
      expect(readCount).toBe(1)
      expect(writeCount).toBe(1)
      expect(
        JSON.parse(storedContent) as {
          clientIdentities: Record<string, unknown>
        },
      ).toMatchObject({
        clientIdentities: {
          [identityKey]: created,
        },
      })
    },
  )
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
