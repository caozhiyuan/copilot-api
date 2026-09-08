import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))

test("startup publishes the bound port and serves authenticated routes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "server-startup-"))
  const healthFile = path.join(directory, "runtime", "health")
  fs.writeFileSync(
    path.join(directory, "config.json"),
    JSON.stringify({
      auth: { apiKeys: ["synthetic-key"], adminApiKey: "synthetic-admin" },
      providers: {
        smoke: {
          enabled: true,
          type: "openai-compatible",
          apiKey: "synthetic-provider",
          baseUrl: "http://127.0.0.1:9/v1",
        },
      },
    }),
  )
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "src/main.ts",
      "start",
      "--port",
      "0",
      "--proxy-env",
    ],
    cwd,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "4141",
      COPILOT_API_HOME: directory,
      COPILOT_API_HEALTHCHECK_FILE: healthFile,
      COPILOT_API_GITHUB_TOKEN: "",
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      NODE_ENV: "production",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    const deadline = Date.now() + 10_000
    while (
      !fs.existsSync(healthFile)
      && Date.now() < deadline
      && child.exitCode === null
    )
      await Bun.sleep(50)
    if (!fs.existsSync(healthFile)) {
      child.kill()
      await child.exited
      throw new Error(
        "Server did not start: " + (await stdout) + (await stderr),
      )
    }
    const url = fs.readFileSync(healthFile, "utf8").trim()
    expect(new URL(url).port).not.toBe("0")
    expect(new URL(url).port).not.toBe("4141")
    expect(await (await fetch(url)).text()).toBe("Server running")
    expect((await fetch(url + "models")).status).toBe(401)
    expect(
      (
        await fetch(url + "models", {
          headers: { Authorization: "Bearer synthetic-key" },
        })
      ).status,
    ).toBe(200)
  } finally {
    child.kill()
    await child.exited
    await Promise.all([stdout, stderr])
    fs.rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
