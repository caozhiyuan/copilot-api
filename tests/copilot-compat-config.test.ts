import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  getConfig,
  isCopilotResponsesCompatibilityEnabled,
} from "~/lib/config-store"

const directories: Array<string> = []

test("the loaded compatibility allowlist changes only the named model", () => {
  const config = getConfig()
  const original = config.copilotResponsesCompatibilityModels
  try {
    config.copilotResponsesCompatibilityModels = ["gpt-test"]
    expect(isCopilotResponsesCompatibilityEnabled("gpt-test")).toBe(true)
    expect(isCopilotResponsesCompatibilityEnabled("gpt-other")).toBe(false)
    config.copilotResponsesCompatibilityModels = []
    expect(isCopilotResponsesCompatibilityEnabled("gpt-test")).toBe(false)
    delete config.copilotResponsesCompatibilityModels
    expect(isCopilotResponsesCompatibilityEnabled("gpt-test")).toBe(false)
  } finally {
    if (original === undefined)
      delete config.copilotResponsesCompatibilityModels
    else config.copilotResponsesCompatibilityModels = original
  }
})

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

test("Copilot compatibility is disabled by default and enables exact model IDs only", () => {
  const values: Array<{ value?: unknown; expected: boolean }> = [
    { expected: false },
    { value: [], expected: false },
    { value: "gpt-test", expected: false },
    { value: ["gpt-test"], expected: true },
    { value: ["gpt-test-2", "*"], expected: false },
    { value: [null, 1, "gpt-test"], expected: true },
    { value: [" gpt-test "], expected: false },
  ]
  for (const { value, expected } of values) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "copilot-compat-config-"),
    )
    directories.push(directory)
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify({
        auth: { adminApiKey: "test-admin-key" },
        copilotResponsesCompatibilityModels: value,
      }),
    )
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        'const { isCopilotResponsesCompatibilityEnabled } = await import("./src/lib/config"); console.log(isCopilotResponsesCompatibilityEnabled("gpt-test"));',
      ],
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        COPILOT_API_HOME: directory,
        COPILOT_API_OAUTH_APP: "",
        COPILOT_API_ENTERPRISE_URL: "",
      },
    })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).trim()).toBe(
      String(expected),
    )
  }
})
