import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import { state } from "../src/lib/state"
import { cacheModels, sleep, stopModelsRefreshLoop } from "../src/lib/utils"

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

beforeEach(() => {
  state.models = undefined
  fetcherMock.mockClear()
  fetcherMock.mockImplementation(() => Promise.resolve(makeModels(["m1"])))
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
