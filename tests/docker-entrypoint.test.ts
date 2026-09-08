import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("../", import.meta.url))
const shell = process.platform === "win32" ? null : Bun.which("sh")
const directories: Array<string> = []
const decoder = new TextDecoder()

function fixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "docker-entrypoint-"))
  directories.push(directory)
  return directory
}

function runEntrypoint(
  args: Array<string>,
  overrides: Record<string, string | undefined> = {},
) {
  const directory = fixture()
  fs.writeFileSync(
    path.join(directory, "bun"),
    "#!/bin/sh\n" + 'printf "%s\\0" "$COPILOT_API_GITHUB_TOKEN" "$HOST" "$@"\n',
    { mode: 0o755 },
  )
  const result = Bun.spawnSync({
    cmd: [shell!, "entrypoint.sh", ...args],
    cwd,
    env: {
      ...process.env,
      PATH: directory + path.delimiter + (process.env.PATH ?? ""),
      GH_TOKEN: "",
      COPILOT_API_GITHUB_TOKEN: "",
      HOST: "",
      COPILOT_API_HOME: directory.replaceAll("\\", "/"),
      ...overrides,
    },
  })
  expect(decoder.decode(result.stderr)).toBe("")
  expect(result.exitCode).toBe(0)
  const [token, host, ...argumentsList] = decoder
    .decode(result.stdout)
    .split("\0")
    .slice(0, -1)
  return { token, host, argumentsList }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe.skipIf(!shell || !fs.existsSync(shell))("container entrypoint", () => {
  test("handles genuinely absent token variables and an unset API home", () => {
    expect(
      runEntrypoint([], {
        GH_TOKEN: undefined,
        COPILOT_API_GITHUB_TOKEN: undefined,
        COPILOT_API_HOME: undefined,
      }).token,
    ).toBe("")
  })

  test("help does not require a writable data directory", () => {
    const filePath = path.join(fixture(), "file")
    fs.writeFileSync(filePath, "not a directory")
    expect(
      runEntrypoint(["--help"], { COPILOT_API_HOME: filePath }).argumentsList,
    ).toContain("--help")
  })

  test("honors the equals form of the API home override", () => {
    const home = path.join(fixture(), "custom")
    runEntrypoint(["--api-home=" + home])
    expect(fs.statSync(home).isDirectory()).toBe(true)
  })

  test.skipIf(process.getuid?.() === 0)(
    "fails closed on inaccessible existing state",
    () => {
      const directory = fixture()
      const configPath = path.join(directory, "config.json")
      const sentinel = '{"auth":{"apiKeys":["preserve-me"]}}'
      fs.writeFileSync(configPath, sentinel, { mode: 0o200 })
      const result = Bun.spawnSync({
        cmd: [shell!, "entrypoint.sh", "auth", "keys", "--list"],
        cwd,
        env: { ...process.env, COPILOT_API_HOME: directory },
      })
      expect(result.exitCode).not.toBe(0)
      expect(decoder.decode(result.stderr)).toContain("refusing to replace")
      fs.chmodSync(configPath, 0o600)
      expect(fs.readFileSync(configPath, "utf8")).toBe(sentinel)
    },
  )

  test.skipIf(process.getuid?.() === 0)(
    "explains an unwritable data directory",
    () => {
      const directory = fixture()
      fs.chmodSync(directory, 0o500)
      try {
        const result = Bun.spawnSync({
          cmd: [shell!, "entrypoint.sh", "auth", "keys", "--list"],
          cwd,
          env: { ...process.env, COPILOT_API_HOME: directory },
        })
        expect(result.exitCode).not.toBe(0)
        expect(decoder.decode(result.stderr)).toContain("Cannot write API home")
        expect(decoder.decode(result.stderr)).toContain("UID:GID")
      } finally {
        fs.chmodSync(directory, 0o700)
      }
    },
  )

  test("starts without an unset token or an injected port argument", () => {
    expect(runEntrypoint([])).toEqual({
      token: "",
      host: "0.0.0.0",
      argumentsList: [
        "--use-system-ca",
        "run",
        "dist/main.js",
        "start",
        "--proxy-env",
      ],
    })
  })

  test.each(["--auth", "auth"])(
    "preserves the %s authentication command",
    (command) => {
      expect(
        runEntrypoint([command, "keys", "--add", "key with spaces"])
          .argumentsList,
      ).toEqual([
        "--use-system-ca",
        "run",
        "dist/main.js",
        "auth",
        "keys",
        "--add",
        "key with spaces",
      ])
    },
  )

  test.each([
    [{ GH_TOKEN: "legacy", COPILOT_API_GITHUB_TOKEN: "" }, "legacy"],
    [
      { GH_TOKEN: "legacy", COPILOT_API_GITHUB_TOKEN: "canonical" },
      "canonical",
    ],
    [{ GH_TOKEN: "", COPILOT_API_GITHUB_TOKEN: "canonical" }, "canonical"],
  ])(
    "maps token environment variables without putting them in argv",
    (environment, expected) => {
      const result = runEntrypoint([], environment)
      expect(result.token).toBe(expected)
      expect(result.argumentsList).not.toContain(expected)
    },
  )

  test("preserves explicit host, port, quoting and proxy opt-out", () => {
    const args = [
      "--port",
      "8080",
      "--api-home",
      path.join(fixture(), "with spaces").replaceAll("\\", "/"),
      "--no-proxy-env",
    ]
    const result = runEntrypoint(["start", ...args], {
      HOST: "127.0.0.1",
      PORT: "9191",
    })
    expect(result.host).toBe("127.0.0.1")
    expect(result.argumentsList).toEqual([
      "--use-system-ca",
      "run",
      "dist/main.js",
      "start",
      "--proxy-env",
      ...args,
    ])
  })
})

test.each([
  ["", [], "4141"],
  ["8088", [], "8088"],
  [" 8088 ", [], "8088"],
  ["8088", ["--port", "9090"], "9090"],
  ["8088", ["-p", "9091"], "9091"],
  ["8088", ["--port=9092"], "9092"],
])("CLI uses PORT=%s only as a default", (port, args, expected) => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      [
        'import { parseArgs } from "citty"',
        'import { start } from "./src/start"',
        "const parsed = parseArgs(JSON.parse(process.env.TEST_ARGS), start.args)",
        'process.stdout.write(JSON.stringify({port:parsed.port,proxy:parsed["proxy-env"]}))',
      ].join("\n"),
    ],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: fixture(),
      PORT: port,
      TEST_ARGS: JSON.stringify(["--proxy-env", ...args, "--no-proxy-env"]),
    },
  })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(decoder.decode(result.stdout))).toEqual({
    port: expected,
    proxy: false,
  })
})

test("container shell scripts stay LF even on Windows checkouts", () => {
  for (const filename of ["entrypoint.sh", "healthcheck.sh"]) {
    expect(fs.readFileSync(path.join(cwd, filename), "utf8")).not.toContain(
      "\r",
    )
  }
})
