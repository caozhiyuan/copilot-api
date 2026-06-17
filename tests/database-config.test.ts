import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { DatabaseConfig, ResolvedDatabaseConfig } from "~/lib/config"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

// Env vars that influence database resolution. Cleared from the inherited
// environment so a value set by the parent test process can't leak in.
const DB_ENV_KEYS = [
  "COPILOT_API_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "COPILOT_API_SQLITE_DB_PATH",
]

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-db-cfg-"))
  tempDirs.push(tempDir)
  return tempDir
}

interface ResolveInput {
  env?: Record<string, string>
  database?: DatabaseConfig
}

// Runs `expr` (a JS expression) in an isolated subprocess with a temp
// COPILOT_API_HOME, so each case sees a clean env + on-disk config. Returns the
// expression's stringified value written to stdout.
function runInSubprocess(input: ResolveInput, expr: string): string {
  const tempDir = createTempDir()
  if (input.database) {
    fs.writeFileSync(
      path.join(tempDir, "config.json"),
      `${JSON.stringify({ database: input.database }, null, 2)}\n`,
      "utf8",
    )
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    COPILOT_API_HOME: tempDir,
    COPILOT_API_OAUTH_APP: "",
    COPILOT_API_ENTERPRISE_URL: "",
  }
  for (const key of DB_ENV_KEYS) {
    delete env[key]
  }
  Object.assign(env, input.env ?? {})

  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", `process.stdout.write(${expr})`],
    cwd,
    env,
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `subprocess failed (${result.exitCode})\n${decoder.decode(result.stderr)}`,
    )
  }

  return decoder.decode(result.stdout)
}

function resolveDatabaseConfig(
  input: ResolveInput = {},
): ResolvedDatabaseConfig {
  const stdout = runInSubprocess(
    input,
    'JSON.stringify((await import("./src/lib/config")).getDatabaseConfig())',
  )
  return JSON.parse(stdout) as ResolvedDatabaseConfig
}

function describeStorage(input: ResolveInput = {}): string {
  return runInSubprocess(
    input,
    '(await import("./src/lib/token-usage")).describeTokenUsageStorage()',
  )
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("getDatabaseConfig", () => {
  describe("environment connection string", () => {
    test("infers turso from a libsql:// url", () => {
      expect(
        resolveDatabaseConfig({
          env: { COPILOT_API_DATABASE_URL: "libsql://my-db.turso.io" },
        }),
      ).toEqual({ type: "turso", url: "libsql://my-db.turso.io" })
    })

    test("infers turso from https:// and ws:// schemes", () => {
      expect(
        resolveDatabaseConfig({
          env: { COPILOT_API_DATABASE_URL: "https://my-db.turso.io" },
        }).type,
      ).toBe("turso")
      expect(
        resolveDatabaseConfig({
          env: { COPILOT_API_DATABASE_URL: "wss://my-db.turso.io" },
        }).type,
      ).toBe("turso")
    })

    test("picks up the turso auth token from TURSO_AUTH_TOKEN", () => {
      expect(
        resolveDatabaseConfig({
          env: {
            COPILOT_API_DATABASE_URL: "libsql://my-db.turso.io",
            TURSO_AUTH_TOKEN: "env-token",
          },
        }),
      ).toEqual({
        type: "turso",
        url: "libsql://my-db.turso.io",
        authToken: "env-token",
      })
    })

    test("accepts the legacy COPILOT_API_SQLITE_DB_PATH as a fallback", () => {
      expect(
        resolveDatabaseConfig({
          env: { COPILOT_API_SQLITE_DB_PATH: "libsql://legacy.turso.io" },
        }),
      ).toEqual({ type: "turso", url: "libsql://legacy.turso.io" })
    })

    test("COPILOT_API_DATABASE_URL takes precedence over the legacy alias", () => {
      expect(
        resolveDatabaseConfig({
          env: {
            COPILOT_API_DATABASE_URL: "libsql://primary.turso.io",
            COPILOT_API_SQLITE_DB_PATH: ":memory:",
          },
        }),
      ).toMatchObject({ url: "libsql://primary.turso.io" })
    })
  })

  describe("legacy COPILOT_API_SQLITE_DB_PATH", () => {
    test("resolves :memory: to local sqlite", () => {
      expect(
        resolveDatabaseConfig({
          env: { COPILOT_API_SQLITE_DB_PATH: ":memory:" },
        }),
      ).toEqual({ type: "sqlite", path: ":memory:" })
    })

    test("resolves a filesystem path to local sqlite", () => {
      expect(
        resolveDatabaseConfig({
          env: { COPILOT_API_SQLITE_DB_PATH: "/tmp/usage.sqlite" },
        }),
      ).toEqual({ type: "sqlite", path: "/tmp/usage.sqlite" })
    })

    test("infers turso when given a libsql:// url (scheme wins over the name)", () => {
      expect(
        resolveDatabaseConfig({
          env: { COPILOT_API_SQLITE_DB_PATH: "libsql://legacy.turso.io" },
        }),
      ).toEqual({ type: "turso", url: "libsql://legacy.turso.io" })
    })
  })

  describe("config.json database block", () => {
    test("selects turso from a libsql:// url", () => {
      expect(
        resolveDatabaseConfig({
          database: { url: "libsql://cfg.turso.io", authToken: "cfg-token" },
        }),
      ).toEqual({
        type: "turso",
        url: "libsql://cfg.turso.io",
        authToken: "cfg-token",
      })
    })

    test("env TURSO_AUTH_TOKEN overrides the config auth token", () => {
      expect(
        resolveDatabaseConfig({
          database: { url: "libsql://cfg.turso.io", authToken: "cfg-token" },
          env: { TURSO_AUTH_TOKEN: "env-token" },
        }),
      ).toMatchObject({ authToken: "env-token" })
    })

    test("uses local sqlite when the config block has no url", () => {
      expect(
        resolveDatabaseConfig({ database: { authToken: "orphan-token" } }).type,
      ).toBe("sqlite")
    })

    test("treats a local path in url as sqlite", () => {
      expect(
        resolveDatabaseConfig({ database: { url: "/data/custom.sqlite" } }),
      ).toEqual({ type: "sqlite", path: "/data/custom.sqlite" })
    })

    test("env connection string overrides the config block", () => {
      expect(
        resolveDatabaseConfig({
          database: { url: "/data/custom.sqlite" },
          env: { COPILOT_API_DATABASE_URL: "libsql://env.turso.io" },
        }),
      ).toEqual({ type: "turso", url: "libsql://env.turso.io" })
    })
  })

  describe("defaults", () => {
    test("defaults to a local sqlite file when nothing is configured", () => {
      const resolved = resolveDatabaseConfig()
      expect(resolved.type).toBe("sqlite")
      expect(
        (resolved as { type: "sqlite"; path: string }).path.endsWith(
          "copilot-api.sqlite",
        ),
      ).toBe(true)
    })
  })
})

describe("describeTokenUsageStorage", () => {
  test("describes a turso remote with its url", () => {
    expect(
      describeStorage({
        env: { COPILOT_API_DATABASE_URL: "libsql://my-db.turso.io" },
      }),
    ).toBe("Turso/libsql remote (libsql://my-db.turso.io)")
  })

  test("describes an in-memory sqlite database", () => {
    expect(
      describeStorage({ env: { COPILOT_API_SQLITE_DB_PATH: ":memory:" } }),
    ).toBe("local SQLite (:memory:)")
  })

  test("describes the default local sqlite file path", () => {
    const description = describeStorage()
    expect(description.startsWith("local SQLite (")).toBe(true)
    expect(description.endsWith("copilot-api.sqlite)")).toBe(true)
  })

  test("does not leak the turso auth token", () => {
    expect(
      describeStorage({
        env: {
          COPILOT_API_DATABASE_URL: "libsql://my-db.turso.io",
          TURSO_AUTH_TOKEN: "super-secret-token",
        },
      }),
    ).not.toContain("super-secret-token")
  })
})
