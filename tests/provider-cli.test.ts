import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { runCommand } from "citty"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AppConfig } from "~/lib/config-store"
import { invalidateConfigCache } from "~/lib/config-store"
import { PATHS } from "~/lib/paths"
import { provider } from "../src/provider"

const tempDirs: Array<string> = []
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})
async function runProvider(
  command: string,
  name: string,
  initialEnabled = true,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-cli-"))
  tempDirs.push(dir)
  const configPath = path.join(dir, "config.json")
  const initial: AppConfig = {
    auth: { apiKeyConfigs: [{ id: "keep-key", key: "keep-secret" }] },
    providers: {
      dashscope: {
        enabled: initialEnabled,
        apiKey: "keep-provider-secret",
        baseUrl: "https://example.test",
        agentsModels: ["model"],
        models: { model: { temperature: 0.2 } },
      },
    },
    extraPrompts: { model: "keep" },
  }
  fs.writeFileSync(configPath, JSON.stringify(initial))
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/main.ts",
      "provider",
      command,
      name,
      "--api-home",
      dir,
    ],
    {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    exit,
    output: stdout + stderr,
    initial,
    stored: JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig,
  }
}
describe("provider CLI", () => {
  test("command handlers are idempotent and report failures without touching credentials", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-handler-"))
    tempDirs.push(dir)
    const previousPath = PATHS.CONFIG_PATH
    const previousExitCode = process.exitCode
    PATHS.CONFIG_PATH = path.join(dir, "config.json")
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      JSON.stringify({ providers: { custom: { apiKey: "secret" } } }),
    )
    const output = spyOn(process.stdout, "write").mockImplementation(() => true)
    const errors = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      await runCommand(provider, { rawArgs: ["disable", "custom"] })
      await runCommand(provider, { rawArgs: ["disable", "custom"] })
      await runCommand(provider, { rawArgs: ["enable", "custom"] })
      const stored = JSON.parse(
        fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
      ) as AppConfig
      expect(stored.providers?.custom).toEqual({
        apiKey: "secret",
        enabled: true,
      })
      expect(output).toHaveBeenCalledTimes(3)
      await runCommand(provider, { rawArgs: ["disable", "unknown"] })
      expect(process.exitCode).toBe(1)
      expect(errors.mock.calls[0]?.[0]).toContain("not configured")
    } finally {
      output.mockRestore()
      errors.mockRestore()
      PATHS.CONFIG_PATH = previousPath
      invalidateConfigCache()
      process.exitCode = previousExitCode ?? 0
    }
  })
  test.each([
    { command: "disable", enabled: false },
    { command: "enable", enabled: true },
  ])(
    "%s persists only enabled state and prompts for restart",
    async ({ command, enabled }) => {
      const result = await runProvider(command, "dashscope", !enabled)
      expect(result.exit).toBe(0)
      expect(result.output).toContain("Restart")
      expect(result.output).not.toContain("keep-secret")
      expect(result.stored).toEqual({
        ...result.initial,
        providers: {
          dashscope: { ...result.initial.providers?.dashscope, enabled },
        },
      })
    },
  )
  test.each(["enable", "disable"])(
    "%s creates the builtin GitHub Copilot control entry in legacy config",
    async (command) => {
      const result = await runProvider(command, "github-copilot")
      expect(result.exit).toBe(0)
      expect(result.stored).toEqual({
        ...result.initial,
        providers: {
          ...result.initial.providers,
          "github-copilot": { enabled: command === "enable" },
        },
      })
    },
  )
  test("unknown and reserved providers fail without modifying config", async () => {
    for (const name of ["missing", "copilot"]) {
      const result = await runProvider("disable", name)
      expect(result.exit).not.toBe(0)
      expect(result.stored).toEqual(result.initial)
    }
  })
})
