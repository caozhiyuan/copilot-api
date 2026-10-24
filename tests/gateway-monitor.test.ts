import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import consola from "consola"
import * as files from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { loadGatewayPlugins, type GatewayPlugins } from "~/lib/gateway-plugins"

const previousMonitorDir = process.env.COPILOT_API_MONITOR_DIR
const releases: Array<() => void> = []
let plugins: GatewayPlugins | undefined

const request = {
  id: "request-1",
  traceId: "trace-1",
  userAgent: "monitor-test/1.0",
  sessionId: null,
  path: "/v1/messages",
  port: 5000,
  startedAt: 123,
  model: null,
  actualModel: null,
}

interface Snapshot {
  requests: Record<string, { model: string; actual_model: string | null }>
}

async function settle(): Promise<void> {
  await new Promise<void>((done) => setImmediate(done))
}

async function createMonitor() {
  let now = 0
  const timers = new Map<
    ReturnType<typeof setTimeout>,
    { at: number; callback: () => void }
  >()
  const setTimer = Object.assign(
    (callback: () => void, delay = 0) => {
      const timer = {
        unref() {
          return this
        },
      } as ReturnType<typeof setTimeout>
      timers.set(timer, { at: now + delay, callback })
      return timer
    },
    { __promisify__: setTimeout.__promisify__ },
  )
  spyOn(globalThis, "setTimeout").mockImplementation(setTimer)
  spyOn(globalThis, "clearTimeout").mockImplementation((timer) => {
    timers.delete(timer as ReturnType<typeof setTimeout>)
  })
  spyOn(files, "mkdir").mockResolvedValue(undefined)
  const write = spyOn(files, "writeFile").mockResolvedValue(undefined)
  const rename = spyOn(files, "rename").mockResolvedValue(undefined)
  const remove = spyOn(files, "rm").mockResolvedValue(undefined)
  const append = spyOn(files, "appendFile").mockResolvedValue(undefined)
  const log = spyOn(consola, "info").mockImplementation(
    Object.assign(() => {}, { raw: () => {} }),
  )
  process.env.COPILOT_API_MONITOR_DIR = join(tmpdir(), "gateway-monitor-unit")
  plugins = await loadGatewayPlugins(
    JSON.stringify([resolve("plugin/gateway/monitor.mjs")]),
    { port: 5000, baseDir: process.cwd() },
  )
  if (!plugins?.enabled) throw new Error("Monitor plugin failed to load")
  const runtime = plugins

  return {
    runtime,
    write,
    rename,
    remove,
    append,
    log,
    delays: () => [...timers.values()].map(({ at }) => at - now),
    snapshots: () =>
      write.mock.calls.map(([, payload]) => {
        if (typeof payload !== "string") throw new Error("Expected JSON string")
        return JSON.parse(payload) as Snapshot
      }),
    blockNextWrite(fail = false) {
      const gate = Promise.withResolvers<void>()
      releases.push(gate.resolve)
      write.mockImplementationOnce(async () => {
        await gate.promise
        if (fail) throw new Error("Temporary snapshot failure")
      })
      return gate.resolve
    },
    async advance(ms: number) {
      now += ms
      for (const [timer, { at, callback }] of [...timers]) {
        if (at <= now) {
          timers.delete(timer)
          callback()
        }
      }
      await settle()
    },
  }
}

let monitor: Awaited<ReturnType<typeof createMonitor>>

beforeEach(async () => {
  monitor = await createMonitor()
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try {
    await plugins?.close()
  } finally {
    plugins = undefined
    mock.restore()
    if (previousMonitorDir === undefined)
      delete process.env.COPILOT_API_MONITOR_DIR
    else process.env.COPILOT_API_MONITOR_DIR = previousMonitorDir
  }
})

describe("gateway monitor snapshots", () => {
  test("coalesces changes during slow I/O into one latest snapshot", async () => {
    const release = monitor.blockNextWrite()
    monitor.runtime.publish("request.start", request)
    await monitor.runtime.flush()
    await monitor.advance(50)

    for (let index = 1; index <= 100; index++) {
      monitor.runtime.publish("request.actual_model", {
        ...request,
        actualModel: `target-${index}`,
      })
      await monitor.runtime.flush()
      await monitor.advance(50)
    }
    expect(monitor.write).toHaveBeenCalledTimes(2)

    release()
    await settle()
    await monitor.advance(50)
    expect(monitor.write).toHaveBeenCalledTimes(3)
    expect(monitor.rename).toHaveBeenCalledTimes(3)
    expect(monitor.snapshots().at(-1)).toMatchObject({
      requests: { "request-1": { actual_model: "target-100" } },
    })
    expect(monitor.delays()).toEqual([])
  })

  test("retries the latest state after a failed write without another event", async () => {
    monitor.runtime.publish("request.start", request)
    await monitor.runtime.flush()
    await monitor.advance(50)

    const release = monitor.blockNextWrite(true)
    monitor.runtime.publish("request.first_token", {
      ...request,
      firstTokenMs: 123,
    })
    await monitor.runtime.flush()
    await monitor.advance(50)
    monitor.runtime.publish("request.end", {
      ...request,
      durationMs: 500,
      firstTokenMs: 123,
      status: 200,
      outcome: "completed",
    })
    await monitor.runtime.flush()
    await monitor.advance(50)

    release()
    await settle()
    expect(monitor.log).toHaveBeenCalledTimes(1)
    expect(monitor.delays()).toEqual([100])
    await monitor.advance(99)
    expect(monitor.write).toHaveBeenCalledTimes(3)
    await monitor.advance(1)
    expect(monitor.write).toHaveBeenCalledTimes(4)
    expect(monitor.rename).toHaveBeenCalledTimes(3)
    expect(monitor.snapshots().at(-1)).toMatchObject({ requests: {} })
    expect(monitor.append).toHaveBeenCalledTimes(1)
    expect(monitor.delays()).toEqual([])
  })

  test("caps retry backoff, preserves updates and resets delay after recovery", async () => {
    monitor.rename.mockRejectedValue(new Error("Temporary rename failure"))
    monitor.runtime.publish("request.start", request)
    await monitor.runtime.flush()
    await monitor.advance(50)
    monitor.runtime.publish("request.actual_model", {
      ...request,
      actualModel: "latest-target",
    })
    await monitor.runtime.flush()

    for (const delay of [100, 200, 400, 800, 1600, 3200, 5000, 5000]) {
      expect(monitor.delays()).toEqual([delay])
      await monitor.advance(delay)
    }
    expect(monitor.delays()).toEqual([5000])
    monitor.rename.mockResolvedValue(undefined)
    await monitor.advance(5000)
    expect(monitor.snapshots().at(-1)).toMatchObject({
      requests: { "request-1": { actual_model: "latest-target" } },
    })
    expect(monitor.delays()).toEqual([])

    monitor.runtime.publish("request.model", { ...request, model: "new-model" })
    await monitor.runtime.flush()
    expect(monitor.delays()).toEqual([50])
    await monitor.advance(50)
    expect(monitor.snapshots().at(-1)).toMatchObject({
      requests: { "request-1": { model: "new-model" } },
    })
  })

  test.each([false, true])(
    "waits for an active write before cleanup without restarting it (failure=%s)",
    async (fail) => {
      const release = monitor.blockNextWrite(fail)
      monitor.runtime.publish("request.start", request)
      await monitor.runtime.flush()
      await monitor.advance(50)
      monitor.runtime.publish("request.actual_model", {
        ...request,
        actualModel: "latest-target",
      })
      await monitor.runtime.flush()
      const closed = monitor.runtime.close()
      await settle()
      expect(monitor.remove).not.toHaveBeenCalled()
      release()
      await closed
      expect(monitor.remove.mock.calls.map(([path]) => String(path))).toEqual([
        join(
          process.env.COPILOT_API_MONITOR_DIR!,
          `inflight-5000-${process.pid}.json`,
        ),
        join(
          process.env.COPILOT_API_MONITOR_DIR!,
          `inflight-5000-${process.pid}.json.tmp`,
        ),
      ])
      expect(monitor.delays()).toEqual([])
      await monitor.advance(10_000)
      expect(monitor.write).toHaveBeenCalledTimes(2)
    },
  )

  test("cancels a scheduled retry on shutdown", async () => {
    monitor.write.mockRejectedValue(new Error("Temporary snapshot failure"))
    monitor.runtime.publish("request.start", request)
    await monitor.runtime.flush()
    await monitor.advance(50)
    expect(monitor.delays()).toEqual([100])

    await monitor.runtime.close()
    expect(monitor.delays()).toEqual([])
    expect(monitor.remove).toHaveBeenCalledTimes(2)
    await monitor.advance(10_000)
    expect(monitor.write).toHaveBeenCalledTimes(2)
  })
})
