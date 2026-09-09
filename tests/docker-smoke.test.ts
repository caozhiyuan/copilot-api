import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"

const image = process.env.COPILOT_API_DOCKER_TEST_IMAGE
const containers: Array<string> = []
const volumes: Array<string> = []
const decoder = new TextDecoder()
const hardening = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777",
  "--network=none",
]
const provider = {
  type: "openai-compatible",
  baseUrl: "http://127.0.0.1:9/v1",
  apiKey: "synthetic-provider-key",
  enabled: true,
}

function command(args: Array<string>, allowFailure = false) {
  const result = Bun.spawnSync({ cmd: ["docker", ...args], timeout: 60_000 })
  const output = decoder.decode(result.stdout).trim()
  const error = decoder.decode(result.stderr).trim()
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error("Docker command failed: " + args[0] + "\n" + error)
  }
  return { code: result.exitCode, output, error }
}

function createVolume(): string {
  const volume = "copilot-review-" + randomUUID()
  command(["volume", "create", volume])
  volumes.push(volume)
  return volume
}

function volumeArguments(volume: string): Array<string> {
  return ["--mount", "type=volume,src=" + volume + ",dst=/data"]
}

function runScript(volume: string, script: string, root = false) {
  return command([
    "run",
    "--rm",
    ...volumeArguments(volume),
    ...(root ? ["--user=0"] : []),
    "--network=none",
    "--entrypoint=bun",
    image!,
    "--eval",
    script,
  ])
}

function seedProvider(volume: string): void {
  runScript(
    volume,
    [
      'import fs from "node:fs";',
      'const config = JSON.parse(fs.readFileSync("/data/config.json", "utf8"));',
      "config.providers = " + JSON.stringify({ smoke: provider }) + ";",
      'fs.writeFileSync("/data/config.json", JSON.stringify(config));',
    ].join("\n"),
  )
}

function startContainer(volume: string, args: Array<string> = []): string {
  const container = "copilot-review-" + randomUUID()
  containers.push(container)
  command([
    "run",
    "--detach",
    "--name",
    container,
    ...hardening,
    ...volumeArguments(volume),
    "--health-interval=1s",
    "--health-start-period=1s",
    "--env=PORT=8088",
    "--env=ALL_PROXY=http://127.0.0.1:9",
    "--env=NO_PROXY=",
    image!,
    ...args,
  ])
  return container
}

async function waitHealthy(container: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const status = command([
      "inspect",
      "--format={{.State.Status}} {{.State.Health.Status}}",
      container,
    ]).output
    if (status === "running healthy") return
    if (!status.startsWith("running")) break
    await Bun.sleep(250)
  }
  throw new Error(
    "Container did not become healthy:\n"
      + command(["logs", container], true).output,
  )
}

afterEach(() => {
  for (const container of containers.splice(0))
    command(["rm", "--force", container], true)
  for (const volume of volumes.splice(0))
    command(["volume", "rm", volume], true)
})

describe.skipIf(!image)("Docker lifecycle (opt-in)", () => {
  test("bootstrap, hardened startup, proxy-safe health, CLI port and recreation", async () => {
    const volume = createVolume()
    command([
      "run",
      "--rm",
      ...hardening,
      ...volumeArguments(volume),
      image!,
      "--auth",
      "keys",
      "--add",
      "synthetic-gateway-key",
    ])
    seedProvider(volume)
    const container = startContainer(volume, ["--port", "9090"])
    await waitHealthy(container)
    expect(command(["exec", container, "id", "-u"]).output).not.toBe("0")
    expect(
      command([
        "exec",
        container,
        "sh",
        "-c",
        "test ! -w /app/dist/main.js && test -w /data",
      ]).code,
    ).toBe(0)
    expect(
      command(["exec", container, "cat", "/tmp/copilot-api/healthcheck-url"])
        .output,
    ).toBe("http://127.0.0.1:9090/")
    expect(
      command([
        "exec",
        container,
        "curl",
        "--noproxy",
        "*",
        "--max-time",
        "3",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "http://127.0.0.1:9090/models",
      ]).output,
    ).toBe("401")
    command(["stop", "--time=10", container])
    expect(
      command(["inspect", "--format={{.State.ExitCode}}", container]).output,
    ).toBe("0")
    const replacement = startContainer(volume)
    await waitHealthy(replacement)
    expect(
      command(["exec", replacement, "cat", "/tmp/copilot-api/healthcheck-url"])
        .output,
    ).toBe("http://127.0.0.1:8088/")
    expect(
      command([
        "exec",
        replacement,
        "sh",
        "-c",
        "test -w /data && mkdir -p /data/cache && test -w /data/cache",
      ]).code,
    ).toBe(0)
    expect(
      command([
        "run",
        "--rm",
        ...hardening,
        ...volumeArguments(volume),
        image!,
        "auth",
        "keys",
        "--list",
      ]).output,
    ).toContain("synthetic-gateway-key")
  }, 90_000)

  test("fails clearly without keys or with an unwritable data volume", () => {
    const volume = createVolume()
    const noKeys = command(
      ["run", "--rm", ...hardening, ...volumeArguments(volume), image!],
      true,
    )
    expect(noKeys.code).not.toBe(0)
    expect(noKeys.output + noKeys.error).toContain("Refusing to listen")
    runScript(
      volume,
      'import fs from "node:fs"; fs.chownSync("/data", 0, 0); fs.chmodSync("/data", 0o700)',
      true,
    )
    const noWrite = command(
      [
        "run",
        "--rm",
        ...hardening,
        ...volumeArguments(volume),
        image!,
        "auth",
        "keys",
        "--list",
      ],
      true,
    )
    expect(noWrite.code).not.toBe(0)
    expect(noWrite.output + noWrite.error).toContain("Cannot write API home")
  }, 60_000)

  test("preserves legacy unreadable data instead of replacing it", () => {
    const volume = createVolume()
    const sentinel = '{"auth":{"apiKeys":["preserve-me"]}}'
    runScript(
      volume,
      'import fs from "node:fs"; fs.writeFileSync("/data/config.json", '
        + JSON.stringify(sentinel)
        + ", {mode:0o600})",
      true,
    )
    const result = command(
      ["run", "--rm", ...hardening, ...volumeArguments(volume), image!],
      true,
    )
    expect(result.code).not.toBe(0)
    expect(result.output + result.error).toContain("refusing to replace")
    expect(
      runScript(
        volume,
        'import fs from "node:fs"; process.stdout.write(fs.readFileSync("/data/config.json", "utf8"))',
        true,
      ).output,
    ).toBe(sentinel)
  }, 60_000)
})
