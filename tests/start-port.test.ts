import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.COPILOT_API_HOME = mkdtempSync(
  path.join(tmpdir(), "copilot-api-port-"),
)

const { parseServerPort, start } = await import("~/start")

const originalWrite = process.stderr.write.bind(process.stderr)
let stderr = ""

afterEach(() => {
  process.stderr.write = originalWrite
  process.exitCode = 0
  stderr = ""
})

test.each(["1", "4141", "65535", "08"])("accepts TCP port %s", (value) => {
  const exitCode = process.exitCode
  expect(parseServerPort(value)).toBe(Number(value))
  expect(process.exitCode).toBe(exitCode)
})

test.each(["0", "65536", "4141.5", "abc", "", "  ", "-1", "1e3"])(
  "rejects port %j with usage and a non-zero exit code",
  async (value) => {
    captureStderr()
    expect(parseServerPort(value)).toBeNull()
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain(`Invalid port ${JSON.stringify(value)}`)
    expect(stderr).toContain("Usage: copilot-api start --port <1-65535>")

    process.exitCode = 0
    stderr = ""
    await start.run?.({
      args: {
        _: [],
        host: "127.0.0.1",
        port: value,
        "github-token": "",
        "proxy-env": false,
        "show-token": false,
        verbose: false,
      },
      cmd: start,
      rawArgs: ["--port", value],
    })
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain("Usage: copilot-api start --port <1-65535>")
  },
)

const captureStderr = (): void => {
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
}
