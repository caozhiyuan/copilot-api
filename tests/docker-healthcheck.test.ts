import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const shell =
  process.platform === "win32" ?
    "C:/Program Files/Git/usr/bin/sh.exe"
  : Bun.which("sh")
const directories: Array<string> = []

function healthFile(content?: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "docker-health-"))
  directories.push(directory)
  const filePath = path.join(directory, "url")
  if (content !== undefined)
    fs.writeFileSync(filePath, content + String.fromCharCode(10))
  return filePath.replaceAll(String.fromCharCode(92), "/")
}

async function probe(filePath: string): Promise<number> {
  const child = Bun.spawn({
    cmd: [shell!, "healthcheck.sh"],
    cwd,
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      COPILOT_API_HEALTHCHECK_FILE: filePath,
      HTTP_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      all_proxy: "http://127.0.0.1:9",
      NO_PROXY: "",
      no_proxy: "",
    },
  })
  return child.exited
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

describe.skipIf(!shell || !fs.existsSync(shell) || !Bun.which("curl"))(
  "container health probe",
  () => {
    test.each([undefined, "", "file:///etc/passwd", "--help"])(
      "rejects missing or invalid state: %s",
      async (content) => {
        expect(await probe(healthFile(content))).not.toBe(0)
      },
    )

    test("bypasses proxy variables and uses the recorded nondefault port", async () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("healthy"),
      })
      try {
        expect(await probe(healthFile(server.url.href))).toBe(0)
      } finally {
        await server.stop(true)
      }
    })

    test("reports an HTTP failure as unhealthy", async () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("unhealthy", { status: 503 }),
      })
      try {
        expect(await probe(healthFile(server.url.href))).not.toBe(0)
      } finally {
        await server.stop(true)
      }
    })

    test("reports a stopped listener as unhealthy", async () => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("healthy"),
      })
      const filePath = healthFile(server.url.href)
      await server.stop(true)
      expect(await probe(filePath)).not.toBe(0)
    })
  },
)
