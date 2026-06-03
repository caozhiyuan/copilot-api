import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  auth?: { apiKeys?: Array<string>; adminApiKey?: string }
  modelOverrides?: Record<string, unknown>
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempConfigDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-model-overrides-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): string {
  const configPath = path.join(tempDir, "config.json")
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

function readConfigFile(configPath: string): ConfigFileShape {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFileShape
}

function runConfigScript(tempDir: string, script: string): string {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  const stdout = decoder.decode(result.stdout)
  if (result.exitCode !== 0) {
    const stderr = decoder.decode(result.stderr)
    throw new Error(
      `Config script failed with exit code ${result.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    )
  }
  return stdout
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("model overrides config", () => {
  test("getModelOverrides drops entries with empty ids or non-object values", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      modelOverrides: {
        "gpt-5.4": { capabilities: { limits: { max_output_tokens: 32_000 } } },
        "": { name: "ignored" },
        "gpt-5.5": "not-an-object",
      },
    })

    const stdout = runConfigScript(
      tempDir,
      'const { getModelOverrides } = await import("./src/lib/config"); console.log(JSON.stringify(getModelOverrides()));',
    )

    expect(JSON.parse(stdout.trim())).toEqual({
      "gpt-5.4": { capabilities: { limits: { max_output_tokens: 32_000 } } },
    })
  })

  test("setModelOverrides validates, persists, and reloads", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      auth: { apiKeys: ["regular-key"] },
    })

    const stdout = runConfigScript(
      tempDir,
      'const { setModelOverrides } = await import("./src/lib/config"); console.log(JSON.stringify(setModelOverrides({ "gpt-5.4": { supported_endpoints: ["/responses"] } })));',
    )

    expect(JSON.parse(stdout.trim())).toEqual({
      "gpt-5.4": { supported_endpoints: ["/responses"] },
    })

    const config = readConfigFile(configPath)
    expect(config.modelOverrides).toEqual({
      "gpt-5.4": { supported_endpoints: ["/responses"] },
    })
    // unrelated config is preserved
    expect(config.auth?.apiKeys).toEqual(["regular-key"])
  })

  test("setModelOverrides throws on empty model ids", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const stdout = runConfigScript(
      tempDir,
      'const { setModelOverrides } = await import("./src/lib/config"); try { setModelOverrides({ "": { name: "x" } }); console.log("NO_THROW"); } catch (e) { console.log("THREW"); }',
    )

    expect(stdout.trim()).toBe("THREW")
  })

  test("setModelOverrides throws on non-object override values", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const stdout = runConfigScript(
      tempDir,
      'const { setModelOverrides } = await import("./src/lib/config"); try { setModelOverrides({ "gpt-5.4": "nope" }); console.log("NO_THROW"); } catch (e) { console.log("THREW"); }',
    )

    expect(stdout.trim()).toBe("THREW")
  })
})
