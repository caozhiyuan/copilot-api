import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

async function waitForListener(
  port: number,
  listening: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1")
      socket.once("error", () => resolve(false))
      socket.once("connect", () => {
        socket.destroy()
        resolve(true)
      })
    })
    if (connected === listening) return
    await Bun.sleep(20)
  }
  throw new Error(
    `Expected gateway listener to be ${listening ? "open" : "closed"}`,
  )
}

const created = { type: "response.created", response: { id: "resp_fixture" } }
const completed = {
  type: "response.completed",
  response: {
    id: "resp_fixture",
    model: "fixture",
    output: [],
    status: "completed",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  },
}

async function checkShutdown(completeStream: boolean): Promise<void> {
  const release = Promise.withResolvers<void>()
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream<string>({
          start(controller) {
            controller.enqueue(
              `event: ${created.type}\ndata: ${JSON.stringify(created)}\n\n`,
            )
          },
          async pull(controller) {
            await release.promise
            controller.enqueue(
              `event: ${completed.type}\ndata: ${JSON.stringify(completed)}\n\n`,
            )
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
  const home = await mkdtemp(path.join(tmpdir(), "copilot-api-shutdown-"))
  await Bun.write(
    path.join(home, "config.json"),
    JSON.stringify({
      providers: {
        "github-copilot": { enabled: false },
        local: {
          type: "openai-responses",
          enabled: true,
          baseUrl: `${upstream.url.href}v1`,
          apiKey: "fixture-key",
        },
      },
    }),
  )
  const portProbe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  })
  const port = portProbe.port!
  await portProbe.stop(true)

  const gateway = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `const upstreamFetch = globalThis.fetch
    globalThis.fetch = (input, init) => input === "https://models.dev/api.json"
      ? Promise.resolve(Response.json({ "opencode-go": { models: { fixture: { id: "fixture", name: "Fixture" } } } }))
      : upstreamFetch(input, init)
    const { runServer } = await import("./src/start")
    await runServer({ host: "127.0.0.1", port: ${port}, verbose: false, proxyEnv: false, showToken: false })`,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        COPILOT_API_HOME: home,
        SERVER_SHUTDOWN_TIMEOUT: completeStream ? "5" : "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    },
  )
  const logs = Promise.all([gateway.stdout.text(), gateway.stderr.text()])

  try {
    await waitForListener(port, true)
    const response = await fetch(
      `http://127.0.0.1:${port}/local/v1/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture",
          input: "hello",
          stream: true,
        }),
        signal: AbortSignal.timeout(7500),
      },
    )
    expect(response.status).toBe(200)
    const events = response.body!.pipeThrough(new TextDecoderStream())
    const reader = events.getReader()
    expect((await reader.read()).value).toContain(created.type)
    reader.releaseLock()

    const shutdownStarted = performance.now()
    gateway.kill("SIGTERM")
    await waitForListener(port, false)
    if (completeStream) {
      release.resolve()
      expect((await Array.fromAsync(events)).join("")).toContain(completed.type)
    }

    const exitCode = await gateway.exited
    expect(exitCode, (await logs).join("\n")).toBe(0)
    if (!completeStream) {
      expect(performance.now() - shutdownStarted).toBeGreaterThanOrEqual(950)
      return
    }

    using db = new Database(path.join(home, "copilot-api.sqlite"), {
      readonly: true,
    })
    expect(
      db
        .query("SELECT input_tokens, output_tokens FROM token_usage_events")
        .all(),
    ).toEqual([{ input_tokens: 3, output_tokens: 2 }])
  } finally {
    gateway.kill("SIGKILL")
    await gateway.exited
    release.resolve()
    await upstream.stop(true)
    await rm(home, { recursive: true, force: true })
  }
}

// Windows terminates the child directly instead of delivering a POSIX SIGTERM.
test.skipIf(process.platform === "win32")(
  "finishes an active Responses stream and records usage before exit",
  async () => {
    await checkShutdown(true)
  },
  12_000,
)

test.skipIf(process.platform === "win32")(
  "exits when an active stream exceeds the shutdown deadline",
  async () => {
    await checkShutdown(false)
  },
  12_000,
)
