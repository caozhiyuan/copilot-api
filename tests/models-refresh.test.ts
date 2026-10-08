import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import consola from "consola"

import { state } from "~/lib/state"
import { sleep } from "~/lib/utils"
import {
  cacheModels,
  logAvailableModels,
  stopModelsRefreshLoop,
} from "~/services/copilot/models-cache"

const makeModels = (ids: Array<string>) => ({
  data: ids.map((id) => ({
    id,
    model_picker_enabled: true,
    capabilities: { type: "chat" as const },
  })),
})

const fetcherMock = mock(() => Promise.resolve(makeModels(["m1"])))

// Short interval so the background timer fires within test timeouts; 50ms
// is small enough for wait(200ms) to observe one tick yet not a tight loop
// if a stray timer leaks past the afterEach.
const TEST_INTERVAL_MS = 50

// consola levels carry a `.raw` chain, so a plain noop is not enough to
// stand in for them. The spies live for the whole file so assertions keep the
// mock's own type instead of reaching through consola's LogFn signature.
const infoMock = spyOn(consola, "info").mockImplementation(
  Object.assign(() => {}, { raw: () => {} }),
)
const warnMock = spyOn(consola, "warn").mockImplementation(
  Object.assign(() => {}, { raw: () => {} }),
)
const debugMock = spyOn(consola, "debug").mockImplementation(
  Object.assign(() => {}, { raw: () => {} }),
)

beforeEach(() => {
  state.models = undefined
  fetcherMock.mockClear()
  fetcherMock.mockImplementation(() => Promise.resolve(makeModels(["m1"])))
  infoMock.mockClear()
  warnMock.mockClear()
  debugMock.mockClear()
})

afterEach(() => {
  stopModelsRefreshLoop()
})

test("cacheModels populates state.models on first call", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  expect(state.models?.data.map((m) => m.id)).toEqual(["m1"])
  expect(fetcherMock).toHaveBeenCalledTimes(1)
})

test("background timer picks up newly-rolled-out models", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  expect(state.models?.data.map((m) => m.id)).toEqual(["m1"])

  fetcherMock.mockImplementation(() =>
    Promise.resolve(makeModels(["m1", "m2"])),
  )

  await sleep(200)

  expect(fetcherMock.mock.calls.length).toBeGreaterThan(1)
  expect(state.models?.data.map((m) => m.id)).toContain("m2")
})

test("refresh failure keeps the previous cache", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  const before = state.models

  fetcherMock.mockImplementation(() =>
    Promise.reject(new Error("upstream blip")),
  )

  await sleep(500)

  expect(state.models).toEqual(before)
})

test("stopModelsRefreshLoop prevents further refreshes", async () => {
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  stopModelsRefreshLoop()
  const callsAfterStop = fetcherMock.mock.calls.length

  await sleep(500)

  expect(fetcherMock.mock.calls.length).toBe(callsAfterStop)
})

test("a refresh already in flight neither writes state nor revives the loop", async () => {
  const inFlight = Promise.withResolvers<ReturnType<typeof makeModels>>()
  const secondFetchStarted = Promise.withResolvers<void>()
  let calls = 0
  fetcherMock.mockImplementation(() => {
    calls += 1
    if (calls === 1) return Promise.resolve(makeModels(["m1"]))
    secondFetchStarted.resolve()
    return inFlight.promise
  })

  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  const before = state.models

  // The timer has fired and /models is in flight when the reload stops the
  // loop, which is also when a sign-out clears state.models.
  await secondFetchStarted.promise
  stopModelsRefreshLoop()
  const callsAfterStop = fetcherMock.mock.calls.length
  inFlight.resolve(makeModels(["m1", "stale"]))
  await sleep(300)

  expect(state.models).toBe(before)
  expect(state.models?.data.map((m) => m.id)).not.toContain("stale")
  expect(fetcherMock.mock.calls.length).toBe(callsAfterStop)
})

test("a new cacheModels supersedes an in-flight refresh from the old token", async () => {
  const inFlightOldToken =
    Promise.withResolvers<ReturnType<typeof makeModels>>()
  const oldTokenFetchStarted = Promise.withResolvers<void>()
  let calls = 0
  fetcherMock.mockImplementation(() => {
    calls += 1
    if (calls === 1) return Promise.resolve(makeModels(["a1"]))
    oldTokenFetchStarted.resolve()
    return inFlightOldToken.promise
  })

  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  await oldTokenFetchStarted.promise

  // A config reload that switches the GitHub token re-runs cacheModels for the
  // new account while the previous account's /models request is still open.
  fetcherMock.mockImplementation(() => Promise.resolve(makeModels(["b1"])))
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  expect(state.models?.data.map((m) => m.id)).toEqual(["b1"])

  // Pin the fetcher so a loop tick during the wait below cannot rewrite
  // state.models and mask the stale write this test is looking for.
  fetcherMock.mockImplementation(() => new Promise(() => {}))
  inFlightOldToken.resolve(makeModels(["a1", "stale-a"]))
  await sleep(200)

  expect(state.models?.data.map((m) => m.id)).toEqual(["b1"])
})

test("startup lists the models that cacheModels cached", async () => {
  fetcherMock.mockImplementation(() =>
    Promise.resolve(makeModels(["gpt-5", "claude-sonnet-4.6"])),
  )

  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  // Drop the "Models refresh: N new" line so only the banner is left.
  infoMock.mockClear()
  logAvailableModels()

  // The banner is the only startup output that names the usable model IDs, so
  // it must read the cache that runServer just populated.
  expect(infoMock).toHaveBeenCalledTimes(1)
  expect(infoMock).toHaveBeenCalledWith(
    "Available models (2):\n- gpt-5\n- claude-sonnet-4.6",
  )
  expect(warnMock).not.toHaveBeenCalled()
})

test("startup warns instead of printing an empty model list", () => {
  logAvailableModels()

  expect(infoMock).not.toHaveBeenCalled()
  expect(warnMock).toHaveBeenCalledWith(
    "No Copilot models available. Check that the account has Copilot access.",
  )
})

test("periodic refreshes do not reprint the model list", async () => {
  fetcherMock.mockImplementation(() => Promise.resolve(makeModels(["m1"])))
  await cacheModels(fetcherMock as never, TEST_INTERVAL_MS)
  logAvailableModels()
  infoMock.mockClear()

  fetcherMock.mockImplementation(() =>
    Promise.resolve(makeModels(["m1", "m2"])),
  )
  await sleep(200)

  // Only the "Models refresh: N new" summary, never the full list dump.
  expect(infoMock).not.toHaveBeenCalledWith(
    expect.stringContaining("Available models"),
  )
})
