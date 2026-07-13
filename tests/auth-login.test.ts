import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  providers?: Record<
    string,
    {
      apiKey?: string
      authType?: string
      baseUrl?: string
      enabled?: boolean
      imageEndpoints?: Array<string>
      models?: Record<string, unknown>
      pricingCurrency?: string
      type?: string
    }
  >
}

interface PromptCall {
  message: string
  options: {
    default?: string
    initial?: string
    type?: string
  }
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-auth-"))
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): void {
  fs.writeFileSync(
    path.join(tempDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
}

function readConfigFile(tempDir: string): ConfigFileShape {
  return JSON.parse(
    fs.readFileSync(path.join(tempDir, "config.json"), "utf8"),
  ) as ConfigFileShape
}

function runScript(tempDir: string, script: string): string {
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

  if (result.exitCode !== 0) {
    throw new Error(
      `Script failed with exit code ${result.exitCode}\nstdout:\n${decoder.decode(result.stdout)}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }

  return decoder.decode(result.stdout).trim()
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("auth login validation", () => {
  test("rejects an unknown provider name before starting a login flow", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      'const { runAuthLogin } = await import("./src/auth"); try { await runAuthLogin({ provider: "unknown", verbose: false, showToken: false }); console.log("unexpected-success"); } catch (error) { console.log((error instanceof Error ? error.message : String(error)).trim()); }',
    )

    expect(output).toBe(
      "Unknown provider 'unknown'. Expected one of: copilot, codex, opencode-go, deepseek, dashscope, openrouter, custom",
    )
  })

  test("configures deepseek from the quick provider template with defaults", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["deepseek-key", "__default__", ""];
      const promptCalls = [];
      consola.prompt = async (message, options) => {
        promptCalls.push({ message, options });
        return answers.shift();
      };
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "deepseek", verbose: false, showToken: false });
      console.log(JSON.stringify(promptCalls));
      `,
    )

    const promptCalls = JSON.parse(output) as Array<PromptCall>
    expect(promptCalls[2]).toMatchObject({
      message:
        "Enter provider baseUrl (default: https://api.deepseek.com/anthropic)",
      options: {
        default: "https://api.deepseek.com/anthropic",
        initial: "https://api.deepseek.com/anthropic",
        type: "text",
      },
    })
    expect(readConfigFile(tempDir).providers?.deepseek).toEqual({
      apiKey: "deepseek-key",
      baseUrl: "https://api.deepseek.com/anthropic",
      enabled: true,
      pricingCurrency: "CNY",
      type: "anthropic",
    })
  })

  test("masks quick provider apiKey input in an interactive terminal", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["__default__", ""];
      const writes = [];
      const rawModes = [];
      const originalWrite = process.stdout.write.bind(process.stdout);
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      process.stdin.setRawMode = (enabled) => {
        rawModes.push(enabled);
        return process.stdin;
      };
      process.stdin.resume = () => {
        queueMicrotask(() => process.stdin.emit("data", Buffer.from("masked-key\\r")));
        return process.stdin;
      };
      process.stdin.pause = () => process.stdin;
      process.stdout.write = (chunk, encoding, callback) => {
        writes.push(String(chunk));
        if (typeof encoding === "function") encoding();
        if (typeof callback === "function") callback();
        return true;
      };
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "deepseek", verbose: false, showToken: false });
      process.stdout.write = originalWrite;
      console.log(JSON.stringify({ rawModes, writes: writes.join("") }));
      `,
    )

    const maskedPromptOutput = JSON.parse(output) as {
      rawModes: Array<boolean>
      writes: string
    }

    expect(maskedPromptOutput.rawModes).toEqual([true, false])
    expect(maskedPromptOutput.writes).toContain(
      "Enter deepseek apiKey: **********\n",
    )
    expect(maskedPromptOutput.writes).not.toContain("masked-key")
    expect(readConfigFile(tempDir).providers?.deepseek).toEqual({
      apiKey: "masked-key",
      baseUrl: "https://api.deepseek.com/anthropic",
      enabled: true,
      pricingCurrency: "CNY",
      type: "anthropic",
    })
  })

  test("configures deepseek with custom quick provider type and baseUrl", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["deepseek-key", "anthropic", "https://deepseek.example///"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "deepseek", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.deepseek).toEqual({
      apiKey: "deepseek-key",
      baseUrl: "https://deepseek.example",
      enabled: true,
      pricingCurrency: "CNY",
      type: "anthropic",
    })
  })

  test("configures dashscope from the quick provider template with defaults", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["dashscope-key", "__default__", ""];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "dashscope", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.dashscope).toEqual({
      apiKey: "dashscope-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      enabled: true,
      pricingCurrency: "CNY",
      type: "openai-compatible",
    })
  })

  test("configures dashscope with custom quick provider type and baseUrl", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["dashscope-key", "openai-responses", "https://dashscope.example/api///"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "dashscope", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.dashscope).toEqual({
      apiKey: "dashscope-key",
      baseUrl: "https://dashscope.example/api",
      enabled: true,
      pricingCurrency: "CNY",
      type: "openai-responses",
    })
  })

  test("configures openrouter as an anthropic quick provider", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["openrouter-key", ""];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "openrouter", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.openrouter).toEqual({
      apiKey: "openrouter-key",
      baseUrl: "https://openrouter.ai/api",
      enabled: true,
      pricingCurrency: "USD",
      type: "anthropic",
    })
  })

  test("configures openrouter with a custom baseUrl but fixed anthropic type", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["openrouter-key", "https://openrouter.example/api///"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "openrouter", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.openrouter).toEqual({
      apiKey: "openrouter-key",
      baseUrl: "https://openrouter.example/api",
      enabled: true,
      pricingCurrency: "USD",
      type: "anthropic",
    })
  })

  test("configures opencode-go as a fixed openai-compatible quick provider", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["opencode-key", ""];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "opencode-go", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.["opencode-go"]).toEqual({
      apiKey: "opencode-key",
      baseUrl: "https://opencode.ai/zen/go",
      enabled: true,
      pricingCurrency: "USD",
      type: "openai-compatible",
    })
  })

  test("configures opencode-go with a custom baseUrl but fixed openai-compatible type", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["opencode-key", "https://opencode.example/zen/go///"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "opencode-go", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.["opencode-go"]).toEqual({
      apiKey: "opencode-key",
      baseUrl: "https://opencode.example/zen/go",
      enabled: true,
      pricingCurrency: "USD",
      type: "openai-compatible",
    })
  })

  test("preserves quick provider model settings when reconfiguring credentials", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        dashscope: {
          apiKey: "old-key",
          baseUrl: "https://old.example",
          enabled: true,
          imageEndpoints: ["generations", "edits"],
          models: {
            "qwen-plus": {
              temperature: 0.2,
            },
          },
          type: "openai-compatible",
        },
      },
    })

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["new-key", "__default__", ""];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "dashscope", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.dashscope).toEqual({
      apiKey: "new-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      enabled: true,
      imageEndpoints: ["generations", "edits"],
      models: {
        "qwen-plus": {
          temperature: 0.2,
        },
      },
      pricingCurrency: "CNY",
      type: "openai-compatible",
    })
  })

  test("configures a custom provider with the default auth type", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["dash", "openai-compatible", "https://dashscope.example///", "provider-key", "__default__"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "custom", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.dash).toEqual({
      apiKey: "provider-key",
      baseUrl: "https://dashscope.example",
      enabled: true,
      type: "openai-compatible",
    })
  })

  test("configures a custom provider selected from the provider prompt", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["custom", "claude", "anthropic", "https://api.anthropic.example", "provider-key", "x-api-key"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: undefined, verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.claude).toEqual({
      apiKey: "provider-key",
      authType: "x-api-key",
      baseUrl: "https://api.anthropic.example",
      enabled: true,
      type: "anthropic",
    })
  })

  test("writes the selected authorization auth type", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["responses", "openai-responses", "https://responses.example", "provider-key", "authorization"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "custom", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.responses).toEqual({
      apiKey: "provider-key",
      authType: "authorization",
      baseUrl: "https://responses.example",
      enabled: true,
      type: "openai-responses",
    })
  })

  test("preserves custom provider model settings when reconfiguring credentials", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        dash: {
          apiKey: "old-key",
          authType: "x-api-key",
          baseUrl: "https://old.example",
          enabled: true,
          models: {
            "qwen-plus": {
              temperature: 0.2,
            },
          },
          type: "anthropic",
        },
      },
    })

    runScript(
      tempDir,
      `
      const consolaModule = await import("consola");
      const consola = consolaModule.default ?? consolaModule;
      const answers = ["dash", "openai-compatible", "https://new.example", "new-key", "__default__"];
      consola.prompt = async () => answers.shift();
      consola.info = () => {};
      consola.success = () => {};
      const { runAuthLogin } = await import("./src/auth");
      await runAuthLogin({ provider: "custom", verbose: false, showToken: false });
      `,
    )

    expect(readConfigFile(tempDir).providers?.dash).toEqual({
      apiKey: "new-key",
      baseUrl: "https://new.example",
      enabled: true,
      models: {
        "qwen-plus": {
          temperature: 0.2,
        },
      },
      type: "openai-compatible",
    })
  })

  test("rejects invalid custom provider inputs without writing provider config", () => {
    const cases: Array<{ answers: Array<string>; message: string }> = [
      {
        answers: ["copilot"],
        message: "Provider name 'copilot' is reserved for a builtin provider",
      },
      {
        answers: ["codex"],
        message: "Provider name 'codex' is reserved for a builtin provider",
      },
      {
        answers: ["bad/name"],
        message:
          "Provider name must start with a letter or number and contain only letters, numbers, underscores, or hyphens",
      },
      {
        answers: ["dash", "unsupported"],
        message: "No provider type selected",
      },
      {
        answers: ["dash", "anthropic", "   "],
        message: "baseUrl must be a non-empty string",
      },
      {
        answers: ["dash", "anthropic", "https://example.com", "   "],
        message: "apiKey must be a non-empty string",
      },
      {
        answers: [
          "dash",
          "anthropic",
          "https://example.com",
          "provider-key",
          "oauth2",
        ],
        message: "No provider auth type selected",
      },
    ]

    for (const item of cases) {
      const tempDir = createTempDir()
      writeConfigFile(tempDir, {})

      const output = runScript(
        tempDir,
        `
        const consolaModule = await import("consola");
        const consola = consolaModule.default ?? consolaModule;
        const answers = ${JSON.stringify(item.answers)};
        consola.prompt = async () => answers.shift();
        consola.info = () => {};
        consola.success = () => {};
        const { runAuthLogin } = await import("./src/auth");
        try {
          await runAuthLogin({ provider: "custom", verbose: false, showToken: false });
          console.log("unexpected-success");
        } catch (error) {
          console.log((error instanceof Error ? error.message : String(error)).trim());
        }
        `,
      )

      expect(output).toBe(item.message)
      expect(readConfigFile(tempDir).providers).toBeUndefined()
    }
  })
})
