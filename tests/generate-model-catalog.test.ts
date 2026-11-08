import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const shell =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh"
const tempDirs: Array<string> = []
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})

async function generate(output: string, url: string) {
  const normalized = output.replaceAll("\\", "/")
  const shellOutput =
    process.platform === "win32" ?
      `/${normalized[0].toLowerCase()}${normalized.slice(2)}`
    : normalized
  const child = Bun.spawn(
    [shell, "docs/generate-model-catalog.sh", url, shellOutput],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, GITHUB_COPILOT_API_KEY: "test-gateway-key" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exit, output: stdout + stderr }
}

describe("model catalog generator", () => {
  test.skipIf(!fs.existsSync(shell))(
    "exports more than 1 MiB with the full header and 0.166.0 version",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-generator-"))
      tempDirs.push(dir)
      const output = path.join(dir, "model_catalog.json")
      let requestHeaders: Headers | undefined
      let requestUrl: string | undefined
      const catalog = {
        models: [
          {
            slug: "large",
            model_messages: { instructions_template: "x".repeat(1024 * 1024) },
          },
        ],
      }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requestHeaders = request.headers
          requestUrl = request.url
          return Response.json(catalog)
        },
      })
      try {
        const result = await generate(output, server.url.toString())
        expect(result.exit).toBe(0)
        expect(fs.statSync(output).size).toBeGreaterThan(1024 * 1024)
        expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(catalog)
        expect(requestHeaders?.get("x-full-model-catalog")).toBe("true")
        expect(requestHeaders?.get("version")).toBe("0.166.0")
        expect(requestHeaders?.get("user-agent")).toContain("codex-tui/0.166.0")
        expect(requestHeaders?.get("authorization")).toBe(
          "Bearer test-gateway-key",
        )
        expect(new URL(requestUrl!).searchParams.get("client_version")).toBe(
          "0.166.0",
        )
      } finally {
        await server.stop(true)
      }
    },
    15000,
  )
  test.skipIf(!fs.existsSync(shell))(
    "preserves the existing file when catalog validation fails",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-generator-"))
      tempDirs.push(dir)
      const output = path.join(dir, "model_catalog.json")
      const original = JSON.stringify({ models: [{ slug: "existing" }] })
      fs.writeFileSync(output, original)
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json({ models: [] }),
      })
      try {
        const result = await generate(output, server.url.toString())
        expect(result.exit).not.toBe(0)
        expect(fs.readFileSync(output, "utf8")).toBe(original)
        expect(fs.readdirSync(dir)).toEqual(["model_catalog.json"])
      } finally {
        await server.stop(true)
      }
    },
    15000,
  )
})
