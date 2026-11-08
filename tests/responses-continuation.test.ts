import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { requestContext } from "~/lib/request-context"
import {
  closeResponseContinuationStore,
  flushResponseContinuations,
} from "~/lib/response-continuation-store"
import {
  getResponsesContinuationSession,
  hashResponseContext,
  prepareResponsesContinuation,
} from "~/lib/responses-continuation"
import { openSqliteDatabase } from "~/lib/sqlite"
import type {
  ResponseStreamEvent,
  ResponsesPayload,
} from "~/lib/types/responses"

const originalDbPath = process.env.COPILOT_API_SQLITE_DB_PATH
let dir: string
const user = { type: "message", role: "user", content: "hello" } as const
const output = {
  type: "function_call",
  call_id: "call-1",
  name: "read",
  arguments: "{}",
  status: "completed",
} as const
const result = {
  type: "function_call_output",
  call_id: "call-1",
  output: "file contents",
} as const
const payload = (
  input: ResponsesPayload["input"] = [user],
): ResponsesPayload => ({ model: "gpt-test", input, stream: true })
const complete = (
  id = "resp-1",
  items: unknown = [output],
): ResponseStreamEvent =>
  ({
    type: "response.completed",
    response: { id, status: "completed", output: items },
  }) as ResponseStreamEvent

class Connection {
  closed = false
  callbacks: Array<() => void> = []
  readonly id: string
  constructor(id: string) {
    this.id = id
  }
  onClose(callback: () => void) {
    this.callbacks.push(callback)
  }
  close() {
    this.closed = true
    for (const callback of this.callbacks) callback()
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "response-continuation-"))
  process.env.COPILOT_API_SQLITE_DB_PATH = path.join(dir, "metadata.sqlite")
})
afterEach(async () => {
  await closeResponseContinuationStore()
  if (originalDbPath === undefined)
    delete process.env.COPILOT_API_SQLITE_DB_PATH
  else process.env.COPILOT_API_SQLITE_DB_PATH = originalDbPath
  fs.rmSync(dir, { recursive: true, force: true })
})

function seed(
  connection = new Connection("socket"),
  overrides: Partial<ResponsesPayload> = {},
) {
  const attempt = prepareResponsesContinuation(
    { ...payload(), ...overrides },
    connection,
    "scope",
    "session",
    false,
  )
  attempt.observe(complete())
  attempt.finish()
  return connection
}

test("uses current agent affinity for every user agent, not the shared root", () => {
  expect(getResponsesContinuationSession()).toBeUndefined()
  requestContext.run(
    {
      traceId: "trace",
      startTime: 0,
      userAgent: "claude-code",
      rootSessionId: "root",
      sessionAffinity: " root:child ",
      parentSessionId: undefined,
    },
    () => {
      expect(getResponsesContinuationSession()).toBe("root:child")
    },
  )
})

test("fingerprints preserve array order, encrypted fields and unknown settings", () => {
  expect(hashResponseContext({ b: 2, a: { d: 4, c: 3 } })).toBe(
    hashResponseContext({ a: { c: 3, d: 4 }, b: 2 }),
  )
  expect(hashResponseContext([1, 2])).not.toBe(hashResponseContext([2, 1]))
  expect(hashResponseContext({ encrypted_content: "a" })).not.toBe(
    hashResponseContext({ encrypted_content: "b" }),
  )
})

test("continues multiple completed turns with only the new tool/user items", () => {
  const connection = seed()
  const full = payload([user, output, result])
  const next = prepareResponsesContinuation(
    full,
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(true)
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [result],
  })
  expect(full.input).toEqual([user, output, result])
  expect(full.previous_response_id).toBeUndefined()
  next.observe(complete("resp-2", []))
  next.finish()
  const third = prepareResponsesContinuation(
    payload([user, output, result, user]),
    connection,
    "scope",
    "session",
    false,
  )
  expect(third.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [user],
  })
  third.finish()
  expect(connection.callbacks).toHaveLength(1)
})

test.each([
  { name: "model", overrides: { model: "other" } },
  { name: "instructions", overrides: { instructions: "changed" } },
  {
    name: "tools",
    overrides: { tools: [{ type: "function", name: "other" }] },
  },
  { name: "unknown configuration", overrides: { future_option: true } },
  { name: "explicit reset", overrides: { previous_response_id: null } },
  {
    name: "explicit chain",
    overrides: { previous_response_id: "client-response" },
  },
  { name: "warmup", overrides: { generate: false } },
  { name: "string input", overrides: { input: "hello" } },
  { name: "short input", overrides: { input: [user] } },
  {
    name: "edited history",
    overrides: { input: [{ ...user, content: "edited" }, output, result] },
  },
])("sends the full request for $name", ({ overrides }) => {
  const connection = seed()
  const full = {
    ...payload([user, output, result]),
    ...overrides,
  } as ResponsesPayload
  const next = prepareResponsesContinuation(
    full,
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(false)
  expect(next.payload).toBe(full)
  next.finish()
})

test("request timestamps and initiator do not break an otherwise exact chain", () => {
  const connection = seed(undefined, {
    initiator: "user",
    client_metadata: { timestamp: "1" },
  })
  const next = prepareResponsesContinuation(
    {
      ...payload([user, output, result]),
      initiator: "agent",
      client_metadata: { timestamp: "2" },
    },
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(true)
  next.finish()
})

test("never crosses connection, provider/account scope or an explicit full retry", () => {
  const connection = seed()
  for (const [socket, scope, force] of [
    [new Connection("other"), "scope", false],
    [connection, "other-account", false],
    [seed(), "scope", true],
  ] as const) {
    const next = prepareResponsesContinuation(
      payload([user, output, result]),
      socket,
      scope,
      "session",
      force,
    )
    expect(next.usedPrevious).toBe(false)
    next.finish()
  }
})

test("expiry and closed sockets discard the previous chain", () => {
  const connection = seed()
  const now = Date.now
  try {
    Date.now = () => now() + 60 * 60 * 1000 + 1
    const next = prepareResponsesContinuation(
      payload([user, output, result]),
      connection,
      "scope",
      "session",
      false,
    )
    expect(next.usedPrevious).toBe(false)
    next.finish()
  } finally {
    Date.now = now
  }
  const closed = seed()
  closed.close()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    closed,
    "scope",
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.observe(complete())
  next.finish()
})

test.each([
  "cancelled",
  "incomplete",
  "missing-terminal",
  "socket-closed",
  "missing-response",
  "missing-id",
  "missing-output",
])("does not retain %s results", (mode) => {
  const connection = new Connection("socket")
  const controller = new AbortController()
  const first = prepareResponsesContinuation(
    payload(),
    connection,
    "scope",
    "session",
    false,
    controller.signal,
  )
  if (mode === "cancelled") controller.abort()
  if (mode === "socket-closed") connection.close()
  if (mode === "missing-response")
    first.observe({ type: "response.completed" } as ResponseStreamEvent)
  else if (mode === "missing-id") first.observe(complete(""))
  else if (mode === "missing-output") first.observe(complete("resp", null))
  else if (mode !== "missing-terminal")
    first.observe(
      mode === "incomplete" ?
        ({
          ...complete(),
          response: { id: "resp", status: "incomplete", output: [output] },
        } as ResponseStreamEvent)
      : complete(),
    )
  first.finish()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test("uses terminal output instead of a partial done-event list", () => {
  const connection = new Connection("socket")
  const first = prepareResponsesContinuation(
    payload(),
    connection,
    "scope",
    "session",
    false,
  )
  first.observe({
    type: "response.output_item.done",
    output_index: 0,
    item: output,
  } as ResponseStreamEvent)
  first.observe(complete("resp-1", [output, user]))
  first.finish()
  const next = prepareResponsesContinuation(
    payload([user, output, user, result]),
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.payload.input).toEqual([result])
  next.finish()
})

test("uses contiguous done events when the terminal event omits output", () => {
  const connection = new Connection("socket")
  const first = prepareResponsesContinuation(
    payload(),
    connection,
    "scope",
    "session",
    false,
  )
  first.observe({
    type: "response.output_item.done",
    output_index: 0,
    item: output,
  } as ResponseStreamEvent)
  first.observe(complete("resp-1", []))
  first.finish()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.payload.input).toEqual([result])
  next.finish()
})

test("does not retain gaps in done-event output", () => {
  const connection = new Connection("socket")
  const first = prepareResponsesContinuation(
    payload(),
    connection,
    "scope",
    "session",
    false,
  )
  first.observe({
    type: "response.output_item.done",
    output_index: 1,
    item: output,
  } as ResponseStreamEvent)
  first.observe(complete("resp-1", []))
  first.finish()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test("SQLite retains independent metadata after close, expiry and invalidation", async () => {
  const connection = seed()
  await flushResponseContinuations()
  const db = await openSqliteDatabase(process.env.COPILOT_API_SQLITE_DB_PATH!)
  try {
    const rows = db
      .prepare("SELECT * FROM response_continuations")
      .all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      connection_id: "socket",
      session_id: "session",
      response_id: "resp-1",
      prefix_item_count: 2,
    })
    expect(JSON.stringify(rows)).not.toContain("file contents")
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([{ name: "response_continuations" }])
    connection.close()
    await flushResponseContinuations()
    expect(db.prepare("SELECT * FROM response_continuations").all()).toEqual(
      rows,
    )
    db.prepare("UPDATE response_continuations SET expires_at_ms = 0").run()
    seed(new Connection("other"))
    await flushResponseContinuations()
    expect(
      db
        .prepare(
          "SELECT connection_id FROM response_continuations ORDER BY connection_id",
        )
        .all(),
    ).toEqual([{ connection_id: "other" }, { connection_id: "socket" }])
    const next = prepareResponsesContinuation(
      payload([user, output, result]),
      connection,
      "scope",
      "session",
      false,
    )
    expect(next.usedPrevious).toBe(false)
    next.finish()
    await flushResponseContinuations()
    expect(
      db.prepare("SELECT connection_id FROM response_continuations").all(),
    ).toHaveLength(2)
  } finally {
    db.close?.()
  }
})

test("SQLite failures leave live continuation and shutdown usable", async () => {
  process.env.COPILOT_API_SQLITE_DB_PATH = dir
  const connection = seed()
  await flushResponseContinuations()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    "scope",
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(true)
  next.finish()
  await closeResponseContinuationStore()
})
