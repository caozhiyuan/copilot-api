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
  prepareResponsesContinuation,
} from "~/lib/responses-continuation"
import { openSqliteDatabase } from "~/lib/sqlite"
import type {
  ResponseOutputItem,
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
} as const
const result = {
  type: "function_call_output",
  call_id: "call-1",
  output: "file contents",
} as const
const thinking = {
  type: "reasoning",
  id: "reasoning-1",
  summary: [],
  encrypted_content: "cipher",
} satisfies ResponseOutputItem
const text = {
  type: "message",
  id: "message-1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "answer", annotations: [] }],
} satisfies ResponseOutputItem
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
  readonly id: string
  constructor(id = "socket") {
    this.id = id
  }
  close() {
    this.closed = true
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

function seed(items: unknown = [output], connection = new Connection()) {
  const attempt = prepareResponsesContinuation(
    payload(),
    connection,
    "session",
    false,
  )
  attempt.observe(complete("resp-1", items))
  attempt.finish()
  return connection
}

test("uses current agent affinity independently of the shared root", () => {
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

test.each([
  output,
  {
    type: "custom_tool_call",
    call_id: "call-1",
    name: "run",
    input: "command",
  },
  { type: "tool_search_call", call_id: "call-1", arguments: { query: "read" } },
])(
  "uses a typed tool call anchor without confusing its result (%j)",
  (item) => {
    const connection = seed([item])
    const replay = { ...item, id: "client-generated-id", extra_metadata: true }
    const full = payload([user, replay, result, user])
    const original = structuredClone(full)
    const next = prepareResponsesContinuation(
      full,
      connection,
      "session",
      false,
    )
    expect(next.payload).toMatchObject({
      previous_response_id: "resp-1",
      input: [result, user],
    })
    expect(full).toEqual(original)
    next.finish()
  },
)

test.each([output, thinking])(
  "skips assistant text after an opaque anchor (%j)",
  (item) => {
    const connection = seed([item, text])
    const replay = { ...item, id: "replaced-id" }
    const nextUser = { ...user, content: "next question" }
    const prefill = { role: "assistant", content: "new prefill" }
    const next = prepareResponsesContinuation(
      payload([
        user,
        replay,
        {
          role: "assistant",
          content: "client-reformatted answer",
          extra: true,
        },
        { type: "reasoning", summary: [], encrypted_content: "" },
        nextUser,
        prefill,
      ]),
      connection,
      "session",
      false,
    )
    expect(next.payload).toMatchObject({
      previous_response_id: "resp-1",
      input: [nextUser, prefill],
    })
    next.finish()
  },
)

test("chooses the last opaque output anchor and keeps every new tool result", () => {
  const lastCall = { ...output, call_id: "call-2" }
  const lastResult = { ...result, call_id: "call-2" }
  const connection = seed([thinking, output, text, lastCall, text])
  const next = prepareResponsesContinuation(
    payload([user, thinking, output, text, lastCall, text, result, lastResult]),
    connection,
    "session",
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [result, lastResult],
  })
  next.finish()
})

test("continues completed tool turns and never reuses an unfinished request", () => {
  const connection = seed()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    "session",
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [result],
  })
  const lastCall = { ...output, call_id: "call-2" }
  const lastResult = { ...result, call_id: "call-2" }
  next.observe(complete("resp-2", [lastCall]))
  next.finish()
  const full = payload([user, output, result, lastCall, lastResult])
  const third = prepareResponsesContinuation(full, connection, "session", false)
  expect(third.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [lastResult],
  })
  third.finish()
  const resent = prepareResponsesContinuation(
    full,
    connection,
    "session",
    false,
  )
  expect(resent.payload).toBe(full)
  resent.finish()
})

test("anchor matching does not compare earlier history, settings or item IDs", () => {
  const connection = seed()
  const editedCall = { ...output, id: "new-id", arguments: "changed" }
  const next = prepareResponsesContinuation(
    {
      ...payload([
        { ...user, content: "edited earlier history" },
        editedCall,
        result,
      ]),
      instructions: "new instructions",
      tools: [],
      client_metadata: { timestamp: "2" },
    },
    connection,
    "session",
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [result],
    instructions: "new instructions",
  })
  next.finish()
})

test.each([
  { name: "explicit reset", overrides: { previous_response_id: null } },
  {
    name: "explicit chain",
    overrides: { previous_response_id: "client-response" },
  },
  { name: "warmup", overrides: { generate: false } },
  { name: "string input", overrides: { input: "hello" } },
  { name: "missing anchor", overrides: { input: [user, result] } },
  {
    name: "different call ID",
    overrides: { input: [user, { ...output, call_id: "other" }, result] },
  },
  {
    name: "different call type",
    overrides: {
      input: [
        user,
        {
          type: "custom_tool_call",
          name: "read",
          call_id: "call-1",
          input: "{}",
        },
        result,
      ],
    },
  },
  { name: "no new input", overrides: { input: [user, output] } },
  { name: "assistant-only tail", overrides: { input: [user, output, text] } },
])("sends full input for $name", ({ overrides }) => {
  const connection = seed()
  const full = {
    ...payload([user, output, result]),
    ...overrides,
  } as ResponsesPayload
  const next = prepareResponsesContinuation(full, connection, "session", false)
  expect(next.usedPrevious).toBe(false)
  expect(next.payload).toBe(full)
  next.finish()
})

test("changed reasoning ciphertext does not match", () => {
  const connection = seed([thinking, text])
  const next = prepareResponsesContinuation(
    payload([
      user,
      { ...thinking, encrypted_content: "different" },
      text,
      user,
    ]),
    connection,
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test("new or closed connections and a forced retry use full input", () => {
  const closed = seed()
  closed.close()
  for (const [connection, forceFull] of [
    [new Connection("other"), false],
    [closed, false],
    [seed(), true],
  ] as const) {
    const next = prepareResponsesContinuation(
      payload([user, output, result]),
      connection,
      "session",
      forceFull,
    )
    expect(next.usedPrevious).toBe(false)
    next.finish()
  }
})

test("a live connection has no separate one-hour continuation expiry", () => {
  const connection = seed()
  const now = Date.now
  try {
    Date.now = () => now() + 24 * 60 * 60 * 1000
    const next = prepareResponsesContinuation(
      payload([user, output, result]),
      connection,
      "session",
      false,
    )
    expect(next.usedPrevious).toBe(true)
    next.finish()
  } finally {
    Date.now = now
  }
})

test.each([
  { items: [text] },
  { items: [{ type: "reasoning", summary: [], encrypted_content: "" }] },
  { items: [{ ...output, call_id: "" }] },
  { items: [output, { type: "future_server_item" }] },
  {
    items: [
      output,
      { type: "tool_search_output", call_id: "call-1", tools: [] },
    ],
  },
])(
  "responses without a usable anchor keep later requests full (%j)",
  ({ items }) => {
    const connection = seed(items)
    const next = prepareResponsesContinuation(
      payload([user, output, result]),
      connection,
      "session",
      false,
    )
    expect(next.usedPrevious).toBe(false)
    next.finish()
  },
)

test.each([
  "cancelled",
  "cancelled-after-completion",
  "incomplete",
  "missing-terminal",
  "socket-closed",
  "missing-response",
  "missing-id",
  "missing-output",
])("does not retain %s results", (mode) => {
  const connection = new Connection()
  const controller = new AbortController()
  const first = prepareResponsesContinuation(
    payload(),
    connection,
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
          type: "response.completed",
          response: { id: "resp", status: "incomplete", output: [output] },
        } as ResponseStreamEvent)
      : complete(),
    )
  if (mode === "cancelled-after-completion") controller.abort()
  first.finish()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test.each([false, true])(
  "prefers done-event markers with or without completed output (%s)",
  (omitOutput) => {
    const connection = new Connection()
    const first = prepareResponsesContinuation(
      payload(),
      connection,
      "session",
      false,
    )
    first.observe({
      type: "response.output_item.done",
      sequence_number: 1,
      output_index: 1,
      item: text,
    })
    first.observe({
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item: thinking,
    })
    first.observe(complete("resp-1", omitOutput ? [] : [output, text]))
    first.finish()
    const next = prepareResponsesContinuation(
      payload([user, thinking, text, result]),
      connection,
      "session",
      false,
    )
    expect(next.payload).toMatchObject({
      previous_response_id: "resp-1",
      input: [result],
    })
    next.finish()
  },
)

test("uses the done reasoning signature when completed contains a different one", () => {
  const connection = new Connection()
  const first = prepareResponsesContinuation(
    payload(),
    connection,
    "session",
    false,
  )
  const doneThinking = {
    ...thinking,
    encrypted_content: "done-cipher",
    id: "done-id",
  }
  first.observe({
    type: "response.output_item.done",
    sequence_number: 1,
    output_index: 0,
    item: doneThinking,
  })
  first.observe(
    complete("resp-1", [
      {
        ...thinking,
        encrypted_content: "completed-cipher",
        id: "completed-id",
      },
      text,
    ]),
  )
  first.finish()
  const next = prepareResponsesContinuation(
    payload([user, doneThinking, text, user]),
    connection,
    "session",
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [user],
  })
  next.finish()
})

test("completed output fills missing done items without replacing a tool call ID", () => {
  const connection = new Connection()
  const first = prepareResponsesContinuation(
    payload(),
    connection,
    "session",
    false,
  )
  first.observe({
    type: "response.output_item.done",
    sequence_number: 1,
    output_index: 0,
    item: output,
  })
  first.observe(
    complete("resp-1", [{ ...output, call_id: "completed-call-id" }, text]),
  )
  first.finish()
  const next = prepareResponsesContinuation(
    payload([user, output, text, result]),
    connection,
    "session",
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [result],
  })
  next.finish()
})

test("does not retain gaps in done-event output", () => {
  const connection = new Connection()
  const first = prepareResponsesContinuation(
    payload(),
    connection,
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
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test("SQLite keeps only four audit fields and retains rows after connection closure", async () => {
  const connection = seed([thinking, text])
  await flushResponseContinuations()
  const db = await openSqliteDatabase(process.env.COPILOT_API_SQLITE_DB_PATH!)
  try {
    const rows = db
      .prepare("SELECT * FROM response_continuations")
      .all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      connection_id: "socket",
      session_id: "session",
      response_id: "resp-1",
      updated_at_ms: expect.any(Number),
    })
    expect(JSON.stringify(rows)).not.toContain("cipher")
    expect(JSON.stringify(rows)).not.toContain("answer")
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
    ).toEqual([{ name: "response_continuations" }])
    connection.close()
    seed([output], new Connection("other"))
    await flushResponseContinuations()
    expect(
      db
        .prepare(
          "SELECT * FROM response_continuations WHERE connection_id = 'socket'",
        )
        .all(),
    ).toEqual(rows)
    expect(
      db.prepare("SELECT connection_id FROM response_continuations").all(),
    ).toHaveLength(2)
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_response_continuations_expiry'",
        )
        .all(),
    ).toEqual([])
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
    "session",
    false,
  )
  expect(next.usedPrevious).toBe(true)
  next.finish()
  await closeResponseContinuationStore()
})
