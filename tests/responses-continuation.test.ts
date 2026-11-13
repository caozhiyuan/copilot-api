import { expect, test } from "bun:test"

import { requestContext } from "~/lib/request-context"
import {
  getResponsesContinuationSession,
  prepareResponsesContinuation,
} from "~/lib/responses-continuation"
import type {
  ResponseIncompleteEvent,
  ResponseOutputItem,
  ResponseStreamEvent,
  ResponsesPayload,
} from "~/lib/types/responses"

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
const compaction = (encrypted_content: string, id = "compaction-1") =>
  ({
    type: "compaction",
    id,
    encrypted_content,
  }) as const
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
const interrupted = (
  id = "resp-interrupted",
  items: unknown = [thinking],
): ResponseIncompleteEvent =>
  ({
    type: "response.incomplete",
    response: {
      id,
      status: "incomplete",
      incomplete_details: { reason: "interrupted" },
      output: items,
    },
  }) as ResponseIncompleteEvent

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

function seed(items: unknown = [output], connection = new Connection()) {
  const attempt = prepareResponsesContinuation(payload(), connection, false)
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
    const next = prepareResponsesContinuation(full, connection, false)
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
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [result, lastResult],
  })
  next.finish()
})

test.each([
  { content: "answer" },
  { content: [{ type: "input_text", text: "answer" }] },
  { content: [{ type: "output_text", text: "answer" }] },
  {
    content: [
      { type: "input_text", text: "an" },
      { type: "input_text", text: "swer" },
    ],
  },
  { content: [{ type: "refusal", refusal: "answer" }] },
])(
  "continues text-only answers across message representations (%j)",
  ({ content }) => {
    const connection = seed([text])
    const replay = { role: "assistant", content, id: "client-message-id" }
    const next = prepareResponsesContinuation(
      payload([user, replay, user]),
      connection,
      false,
    )
    expect(next.payload).toMatchObject({
      previous_response_id: "resp-1",
      input: [user],
    })
  },
)

test.each([thinking, output])(
  "prefers the opaque anchor even when a matching text message is present (%j)",
  (item) => {
    const connection = seed([item, text])
    const full = payload([user, text, user])
    const next = prepareResponsesContinuation(full, connection, false)
    expect(next.usedPrevious).toBe(false)
    expect(next.payload).toBe(full)
  },
)

test.each([
  { role: "assistant", content: "different answer" },
  { role: "assistant", content: "answer " },
  { role: "assistant", content: [] },
  { role: "assistant", content: null },
  { role: "assistant", content: [{ type: "input_image", image_url: "image" }] },
  { role: "assistant", content: [null] },
  { role: "assistant", content: [{}] },
  { role: "assistant", content: [{ type: "input_text", text: 1 }] },
  { type: "additional_tools", role: "assistant", tools: [] },
])(
  "never searches older text when the last assistant message differs (%j)",
  (last) => {
    const connection = seed([text])
    const full = payload([user, text, user, last, user])
    const next = prepareResponsesContinuation(full, connection, false)
    expect(next.usedPrevious).toBe(false)
    expect(next.payload).toBe(full)
  },
)

test.each([
  { type: "reasoning", summary: [], encrypted_content: "other-cipher" },
  output,
  { type: "file_search_call" },
  { type: "computer_call" },
  { type: "image_generation_call" },
  { type: "code_interpreter_call" },
  { type: "local_shell_call" },
  { type: "shell_call" },
  { type: "apply_patch_call" },
  { type: "mcp_call" },
  { type: "mcp_list_tools" },
  { type: "mcp_approval_request" },
  { type: "program" },
  { type: "program_output" },
  { type: "tool_search_output", execution: "server", tools: [] },
])(
  "finds the last assistant message and skips subsequent assistant items (%j)",
  (last) => {
    const connection = seed([text])
    const next = prepareResponsesContinuation(
      payload([user, text, last, user]),
      connection,
      false,
    )
    expect(next.payload).toMatchObject({
      previous_response_id: "resp-1",
      input: [user],
    })
  },
)

test.each([
  { type: "function_call_output", call_id: "call-1", output: "ok" },
  { type: "custom_tool_call_output", call_id: "call-1", output: "ok" },
  { type: "computer_call_output", call_id: "call-1", output: {} },
  { type: "local_shell_call_output", call_id: "call-1", output: "ok" },
  { type: "shell_call_output", call_id: "call-1", output: [] },
  { type: "apply_patch_call_output", call_id: "call-1", output: "ok" },
  {
    type: "tool_search_output",
    execution: "client",
    call_id: "call-1",
    tools: [],
  },
  {
    type: "mcp_approval_response",
    approval_request_id: "approval-1",
    approve: true,
  },
  {
    type: "agent_message",
    author: "agent-a",
    recipient: "agent-b",
    content: [],
  },
  { type: "additional_tools", role: "developer", tools: [] },
])("preserves new client inputs after a matching text message (%j)", (item) => {
  const connection = seed([text])
  const next = prepareResponsesContinuation(
    payload([user, text, item, user]),
    connection,
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [item, user],
  })
})

test("advances the response ID when a tool turn ends with a text-only answer", () => {
  const connection = seed()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    false,
  )
  next.observe(complete("resp-2", [text]))
  next.finish()
  const third = prepareResponsesContinuation(
    payload([user, output, result, text, user]),
    connection,
    false,
  )
  expect(third.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [user],
  })
})

test.each([
  payload("next"),
  { ...payload(), previous_response_id: "client-response" },
  { ...payload(), generate: false },
])(
  "clears an older checkpoint after an ineligible completed request (%j)",
  (request) => {
    const connection = seed()
    const next = prepareResponsesContinuation(request, connection, false)
    next.observe(complete("resp-2", [text]))
    next.finish()
    expect(
      prepareResponsesContinuation(
        payload([user, output, result]),
        connection,
        false,
      ).usedPrevious,
    ).toBe(false)
  },
)

test("text fallback uses done-event text instead of a different terminal snapshot", () => {
  const connection = new Connection()
  const first = prepareResponsesContinuation(payload(), connection, false)
  first.observe({
    type: "response.output_item.done",
    sequence_number: 1,
    output_index: 0,
    item: text,
  })
  first.observe(
    complete("resp-text", [
      { ...text, content: [{ type: "output_text", text: "different" }] },
    ]),
  )
  first.finish()
  expect(
    prepareResponsesContinuation(payload([user, text, user]), connection, false)
      .payload,
  ).toMatchObject({ previous_response_id: "resp-text", input: [user] })
})

test.each([
  { items: [] },
  { items: null },
  { items: [{ ...text, content: "" }] },
  {
    items: [
      { ...text, content: [{ type: "input_image", image_url: "image" }] },
    ],
  },
  { items: [{ ...text, content: [{ type: "refusal", refusal: 1 }] }] },
  { items: [text, { type: "reasoning", encrypted_content: "", summary: [] }] },
  { items: [text, { type: "future_server_item" }] },
])(
  "clears an older checkpoint when a completed response has no usable anchor (%j)",
  ({ items }) => {
    const connection = seed()
    const full = payload([user, output, result])
    const next = prepareResponsesContinuation(full, connection, false)
    next.observe(complete("resp-2", items))
    next.finish()
    expect(
      prepareResponsesContinuation(full, connection, false).usedPrevious,
    ).toBe(false)
  },
)

test("retains the latest completed tool turn across an unfinished request", () => {
  const connection = seed()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
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
  const third = prepareResponsesContinuation(full, connection, false)
  expect(third.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [lastResult],
  })
  third.finish()
  const resent = prepareResponsesContinuation(full, connection, false)
  expect(resent.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [lastResult],
  })
  resent.finish()
})

test("cancelling after completion leaves the previous checkpoint committed", () => {
  const connection = seed()
  const full = payload([user, output, result])
  const controller = new AbortController()
  const next = prepareResponsesContinuation(
    full,
    connection,
    false,
    controller.signal,
  )
  next.observe(complete("resp-2"))
  controller.abort()
  next.finish()

  const resent = prepareResponsesContinuation(full, connection, false)
  expect(resent.payload).toMatchObject({
    previous_response_id: "resp-1",
    input: [result],
  })
})

test.each([
  { ...thinking, encrypted_content: "interrupted-cipher" },
  { ...output, call_id: "interrupted-call" },
  text,
])("uses the interrupted response's own ID and anchor (%j)", (item) => {
  const connection = seed()
  const controller = new AbortController()
  const full = payload([user, output, result])
  const attempt = prepareResponsesContinuation(
    full,
    connection,
    false,
    controller.signal,
  )
  controller.abort()
  attempt.observe(interrupted("resp-interrupted", [item]))
  attempt.finish()

  const next = prepareResponsesContinuation(
    payload([user, output, result, item, user]),
    connection,
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-interrupted",
    input: [user],
  })
  const missingAnchor = prepareResponsesContinuation(full, connection, false)
  expect(missingAnchor.usedPrevious).toBe(false)
  expect(missingAnchor.payload).toBe(full)
})

test("prefers an interrupted turn's done signature to the terminal snapshot", () => {
  const connection = seed()
  const controller = new AbortController()
  const attempt = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    false,
    controller.signal,
  )
  const doneThinking = { ...thinking, encrypted_content: "done-cipher" }
  attempt.observe({
    type: "response.output_item.done",
    sequence_number: 1,
    output_index: 0,
    item: doneThinking,
  })
  attempt.observe(interrupted())
  controller.abort()
  attempt.finish()

  const next = prepareResponsesContinuation(
    payload([user, output, result, doneThinking, user]),
    connection,
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-interrupted",
    input: [user],
  })
})

test.each([
  { items: [] },
  { items: [text] },
  { items: null },
  { items: [output, { type: "future_server_item" }] },
])(
  "invalidates the old ID when an interrupted response has no usable anchor (%j)",
  ({ items }) => {
    const connection = seed()
    const full = payload([user, output, result])
    const attempt = prepareResponsesContinuation(full, connection, false)
    attempt.observe(interrupted("resp-interrupted", items))
    attempt.finish()

    const next = prepareResponsesContinuation(full, connection, false)
    expect(next.usedPrevious).toBe(false)
    expect(next.payload).toBe(full)
  },
)

test("invalidates the old ID when an interrupted response has no ID", () => {
  const connection = seed()
  const full = payload([user, output, result])
  const attempt = prepareResponsesContinuation(full, connection, false)
  attempt.observe(interrupted(""))
  attempt.finish()
  expect(
    prepareResponsesContinuation(full, connection, false).usedPrevious,
  ).toBe(false)
})

test("invalidates the old ID when the interrupted request cannot be checkpointed", () => {
  const connection = seed()
  const attempt = prepareResponsesContinuation(
    payload("next"),
    connection,
    false,
  )
  attempt.observe(interrupted())
  attempt.finish()
  const next = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    false,
  )
  expect(next.usedPrevious).toBe(false)
})

test.each([undefined, "max_output_tokens", "content_filter"] as const)(
  "preserves the previous checkpoint for other incomplete reasons (%s)",
  (reason) => {
    const connection = seed()
    const full = payload([user, output, result])
    const controller = new AbortController()
    const attempt = prepareResponsesContinuation(
      full,
      connection,
      false,
      controller.signal,
    )
    controller.abort()
    const event = interrupted("resp-incomplete")
    event.response.incomplete_details = reason ? { reason } : null
    attempt.observe(event)
    attempt.finish()
    expect(
      prepareResponsesContinuation(full, connection, false).payload,
    ).toMatchObject({ previous_response_id: "resp-1", input: [result] })
  },
)

test("interrupted checkpoints preserve the compaction boundary", () => {
  const connection = seed()
  const checkpoint = compaction("interrupted-checkpoint")
  const controller = new AbortController()
  const attempt = prepareResponsesContinuation(
    payload([checkpoint, user]),
    connection,
    false,
    controller.signal,
  )
  controller.abort()
  attempt.observe(interrupted())
  attempt.finish()

  const next = prepareResponsesContinuation(
    payload([checkpoint, user, thinking, user]),
    connection,
    false,
  )
  expect(next.payload).toMatchObject({
    previous_response_id: "resp-interrupted",
    input: [user],
  })
  const compacted = payload([
    compaction("new-checkpoint"),
    user,
    thinking,
    user,
  ])
  expect(
    prepareResponsesContinuation(compacted, connection, false).payload,
  ).toBe(compacted)
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
  const next = prepareResponsesContinuation(full, connection, false)
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
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test.each([false, true])(
  "prefers done-event markers with or without completed output (%s)",
  (omitOutput) => {
    const connection = new Connection()
    const first = prepareResponsesContinuation(payload(), connection, false)
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
  const first = prepareResponsesContinuation(payload(), connection, false)
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
  const first = prepareResponsesContinuation(payload(), connection, false)
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
  const first = prepareResponsesContinuation(payload(), connection, false)
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
    false,
  )
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test.each([
  {
    name: "before a surviving anchor",
    input: (checkpoint: ReturnType<typeof compaction>) => [
      checkpoint,
      user,
      output,
      text,
      result,
      user,
    ],
  },
  {
    name: "after a surviving anchor",
    input: (checkpoint: ReturnType<typeof compaction>) => [
      user,
      output,
      text,
      result,
      checkpoint,
      user,
    ],
  },
])(
  "sends the full input when a new compaction checkpoint appears $name",
  ({ input }) => {
    const connection = seed([output, text])
    const checkpoint = compaction("checkpoint")
    const items = input(checkpoint)
    const full = payload(items)
    const original = structuredClone(full)
    const next = prepareResponsesContinuation(full, connection, false)
    expect(next.usedPrevious).toBe(false)
    expect(next.payload).toBe(full)
    expect(next.payload.previous_response_id).toBeUndefined()
    expect(next.payload.input).toEqual(items)
    expect(full).toEqual(original)
    next.finish()
  },
)

test("continues incrementally after the same compaction ciphertext was sent", () => {
  const connection = seed([output, text])
  const checkpoint = compaction("checkpoint")
  const full = payload([checkpoint, user, output, text, result])
  const original = structuredClone(full)
  const next = prepareResponsesContinuation(full, connection, false)
  expect(next.usedPrevious).toBe(false)
  expect(next.payload).toBe(full)
  expect(next.payload.previous_response_id).toBeUndefined()
  expect(full).toEqual(original)
  next.observe(complete("resp-2", [output]))
  next.finish()

  const continued = prepareResponsesContinuation(
    payload([
      compaction("checkpoint", "client-renamed"),
      { ...user, content: "edited history before the anchor" },
      output,
      text,
      result,
      user,
    ]),
    connection,
    false,
  )
  expect(continued.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [result, user],
  })
  continued.observe(complete("resp-3", [{ ...output, call_id: "call-2" }]))
  continued.finish()

  // The incremental body has no compaction item; keep the full-input hash.
  const again = prepareResponsesContinuation(
    payload([
      checkpoint,
      user,
      output,
      text,
      result,
      { ...output, call_id: "call-2" },
      { ...result, call_id: "call-2" },
    ]),
    connection,
    false,
  )
  expect(again.payload).toMatchObject({
    previous_response_id: "resp-3",
    input: [{ ...result, call_id: "call-2" }],
  })
  again.finish()
})

test("only the latest compaction ciphertext gates continuation", () => {
  const connection = seed()
  const latest = compaction("latest", "compaction-2")
  const first = prepareResponsesContinuation(
    payload([compaction("older"), latest, user, output, result]),
    connection,
    false,
  )
  expect(first.usedPrevious).toBe(false)
  first.observe(complete("resp-2"))
  first.finish()

  const continued = prepareResponsesContinuation(
    payload([
      compaction("older-edited"),
      { ...latest, id: "renamed-latest" },
      { ...user, content: "edited" },
      output,
      result,
      user,
    ]),
    connection,
    false,
  )
  expect(continued.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [result, user],
  })
  continued.finish()
})

test.each([
  {
    name: "replaced",
    input: () => [compaction("replacement"), user, output, result, user],
  },
  {
    name: "removed",
    input: () => [user, output, result, user],
  },
  {
    name: "superseded",
    input: () => [
      compaction("checkpoint"),
      compaction("newer", "compaction-2"),
      user,
      output,
      result,
      user,
    ],
  },
])(
  "sends the full input when a compaction checkpoint is $name",
  ({ input }) => {
    const connection = seed()
    const first = prepareResponsesContinuation(
      payload([compaction("checkpoint"), user, output, result]),
      connection,
      false,
    )
    first.observe(complete("resp-2"))
    first.finish()
    const items = input()
    const full = payload(items)
    const next = prepareResponsesContinuation(full, connection, false)
    expect(next.usedPrevious).toBe(false)
    expect(next.payload).toBe(full)
    expect(next.payload.previous_response_id).toBeUndefined()
    expect(next.payload.input).toEqual(items)
    next.finish()
  },
)

test("an explicit previous response id bypasses compaction checkpoint matching", () => {
  const connection = seed()
  const checkpoint = compaction("checkpoint")
  const established = payload([checkpoint, user, output, result])
  const first = prepareResponsesContinuation(established, connection, false)
  first.observe(complete("resp-2"))
  first.finish()

  const full = {
    ...payload([checkpoint, user, output, result, user]),
    previous_response_id: "client-response",
  }
  const next = prepareResponsesContinuation(full, connection, false)
  expect(next.payload).toBe(full)
  expect(next.usedPrevious).toBe(false)
  next.finish()
})

test("different connections do not share compaction checkpoints", () => {
  const left = new Connection("left")
  const right = new Connection("right")
  for (const connection of [left, right]) {
    const first = prepareResponsesContinuation(payload(), connection, false)
    first.observe(complete("resp-1"))
    first.finish()
  }

  const leftCheckpoint = compaction("left-cipher")
  const rightCheckpoint = compaction("right-cipher")
  const adopt = (
    connection: Connection,
    checkpoint: ReturnType<typeof compaction>,
    responseId: string,
  ) => {
    const full = payload([checkpoint, user, output, result])
    const attempt = prepareResponsesContinuation(full, connection, false)
    expect(attempt.payload).toBe(full)
    expect(attempt.usedPrevious).toBe(false)
    attempt.observe(complete(responseId))
    attempt.finish()
  }
  adopt(left, leftCheckpoint, "resp-left")
  adopt(right, rightCheckpoint, "resp-right")

  const leftNext = prepareResponsesContinuation(
    payload([leftCheckpoint, user, output, result, user]),
    left,
    false,
  )
  expect(leftNext.payload).toMatchObject({
    previous_response_id: "resp-left",
    input: [result, user],
  })
  leftNext.observe(complete("resp-left-2"))
  leftNext.finish()

  const rightNext = prepareResponsesContinuation(
    payload([rightCheckpoint, user, output, result, user]),
    right,
    false,
  )
  expect(rightNext.payload).toMatchObject({
    previous_response_id: "resp-right",
    input: [result, user],
  })
  rightNext.finish()

  const crossed = payload([rightCheckpoint, user, output, result])
  const leftCross = prepareResponsesContinuation(crossed, left, false)
  expect(leftCross.usedPrevious).toBe(false)
  expect(leftCross.payload).toBe(crossed)
  leftCross.finish()
})

test.each([
  "cancelled",
  "cancelled-after-completion",
  "incomplete",
  "socket-closed",
] as const)(
  "does not commit a compaction checkpoint when the request is %s",
  (mode) => {
    const connection = seed()
    const checkpoint = compaction("checkpoint")
    const controller = new AbortController()
    const full = payload([checkpoint, user, output, result])
    const attempt = prepareResponsesContinuation(
      full,
      connection,
      false,
      controller.signal,
    )
    expect(attempt.payload).toBe(full)
    if (mode === "cancelled") controller.abort()
    if (mode === "socket-closed") connection.closed = true
    if (mode === "incomplete") {
      attempt.observe({
        type: "response.completed",
        response: { id: "resp-2", status: "incomplete", output: [output] },
      } as ResponseStreamEvent)
    } else if (mode !== "cancelled") attempt.observe(complete("resp-2"))
    if (mode === "cancelled-after-completion") controller.abort()
    attempt.finish()
    if (mode === "socket-closed") connection.closed = false

    const retry = prepareResponsesContinuation(
      payload([checkpoint, user, output, result, user]),
      connection,
      false,
    )
    expect(retry.usedPrevious).toBe(false)
    expect(retry.payload.previous_response_id).toBeUndefined()
    expect(retry.payload.input).toEqual([
      checkpoint,
      user,
      output,
      result,
      user,
    ])
    retry.finish()
  },
)

test("a compaction item produced by the response is recorded on the next full send", () => {
  const connection = seed()
  const turn = prepareResponsesContinuation(
    payload([user, output, result]),
    connection,
    false,
  )
  expect(turn.usedPrevious).toBe(true)
  const produced = compaction("produced-cipher")
  const call = { ...output, call_id: "call-2" }
  turn.observe({
    type: "response.output_item.done",
    sequence_number: 1,
    output_index: 0,
    item: produced,
  })
  turn.observe({
    type: "response.output_item.done",
    sequence_number: 2,
    output_index: 1,
    item: call,
  })
  turn.observe(complete("resp-2", []))
  turn.finish()

  const unchanged = prepareResponsesContinuation(
    payload([user, output, result, call, user]),
    connection,
    false,
  )
  expect(unchanged.payload).toMatchObject({
    previous_response_id: "resp-2",
    input: [user],
  })
  unchanged.observe(complete("resp-3", [call]))
  unchanged.finish()

  const replay = payload([produced, user, output, result, call, user])
  const next = prepareResponsesContinuation(replay, connection, false)
  expect(next.usedPrevious).toBe(false)
  expect(next.payload).toBe(replay)
  expect(next.payload.previous_response_id).toBeUndefined()
  next.observe(complete("resp-4", [call]))
  next.finish()

  const followed = prepareResponsesContinuation(
    payload([produced, user, output, result, call, user]),
    connection,
    false,
  )
  expect(followed.payload).toMatchObject({
    previous_response_id: "resp-4",
    input: [user],
  })
  followed.finish()
})

test.each([
  { type: "compaction", id: "compaction-1" },
  { type: "compaction", id: "compaction-1", encrypted_content: 1 },
])(
  "a compaction item without ciphertext does not match a stored checkpoint (%j)",
  (item) => {
    const connection = seed()
    const first = prepareResponsesContinuation(
      payload([compaction("checkpoint"), user, output, result]),
      connection,
      false,
    )
    first.observe(complete("resp-2"))
    first.finish()
    const full = payload([item, user, output, result, user])
    const next = prepareResponsesContinuation(full, connection, false)
    expect(next.payload).toBe(full)
    expect(next.usedPrevious).toBe(false)
    next.finish()
  },
)
