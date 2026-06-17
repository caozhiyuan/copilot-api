import { type AsyncDatabase, type SqlValue } from "./sqlite"

// Minimal shape of the parts of `@libsql/client` we use. Declared locally so
// type-checking does not require the optional dependency to be installed, and
// so the dynamic import specifier can stay opaque to the bundler.
interface LibsqlResultSet {
  rows: Array<Record<string, unknown>>
}

interface LibsqlClient {
  execute: (statement: {
    sql: string
    args: Array<SqlValue>
  }) => Promise<LibsqlResultSet>
  executeMultiple: (sql: string) => Promise<void>
  close: () => void
}

interface LibsqlModule {
  createClient: (config: {
    url: string
    authToken?: string
    intMode?: "number" | "bigint" | "string"
  }) => LibsqlClient
}

export interface TursoConfig {
  url: string
  authToken?: string
}

export async function openTursoDatabase(
  config: TursoConfig,
): Promise<AsyncDatabase> {
  // Built from parts to dodge eager bundler/type resolution of the optional
  // dependency, mirroring the `["bun", "sqlite"].join(":")` trick in sqlite.ts.
  const specifier = ["@libsql/client", "web"].join("/")
  const { createClient } = (await import(specifier)) as LibsqlModule
  // `intMode: "number"` is mandatory: without it libsql can return INTEGER
  // columns as BigInt, which would silently break every `typeof === "number"`
  // check (and token sum) in the token-usage store.
  const client = createClient({
    url: config.url,
    authToken: config.authToken,
    intMode: "number",
  })

  return {
    kind: "turso",
    exec: async (sql) => {
      await client.executeMultiple(sql)
    },
    prepare: (sql) => ({
      all: async (...args) => (await client.execute({ sql, args })).rows,
      get: async (...args) => (await client.execute({ sql, args })).rows[0],
      run: async (...args) => {
        await client.execute({ sql, args })
      },
    }),
    close: () => Promise.resolve(client.close()),
  }
}
