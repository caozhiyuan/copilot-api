import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/lib/types/responses"

import { createCollaborationCompatibility } from "~/routes/responses/collaboration-compat"

const messageTool = (name: string, encrypted: boolean | undefined = true) => ({
  type: "function",
  name,
  strict: false,
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Keep literal collaboration.spawn_agent in message text",
        ...(encrypted === undefined ? {} : { encrypted }),
      },
      untouched: { type: "string", encrypted: true },
    },
  },
})

const namespace = () => ({
  type: "namespace",
  name: "collaboration",
  description: "Tools for collaboration",
  tools: [
    ...["spawn_agent", "send_message", "followup_task"].map((name) =>
      messageTool(name),
    ),
    { type: "function", name: "wait_agent", parameters: null },
    { type: "function", name: "list_agents", parameters: { type: "object" } },
  ],
})

const call = (ns = "collaboration", name = "spawn_agent") => ({
  type: "function_call",
  namespace: ns,
  name,
  call_id: "call_copilot_collaboration_1",
  id: "fc_1",
  arguments: JSON.stringify({
    message: 'A Unicode task: 租約 😀 "quoted"\ncollaboration.spawn_agent',
    task_name: "child",
  }),
})

const request = (): ResponsesPayload => ({
  model: "gpt-test",
  stream: true,
  input: [
    { type: "additional_tools", role: "developer", tools: [namespace()] },
    { role: "user", content: "Keep collaboration.spawn_agent as written" },
    {
      type: "reasoning",
      encrypted_content: "opaque-reasoning-copilot_collaboration",
      summary: [],
    },
    call(),
    {
      type: "function_call_output",
      call_id: "call_copilot_collaboration_1",
      output: "opaque tool result",
    },
    {
      type: "agent_message",
      author: "/root",
      recipient: "/root/child",
      content: [{ type: "input_text", text: "A task" }],
    },
    {
      type: "custom_tool_call",
      name: "exec",
      namespace: "functions",
      call_id: "exec_1",
      input: 'text("collaboration.spawn_agent")',
    },
  ],
})

function prepare(payload = request()) {
  const result = createCollaborationCompatibility(payload)
  expect(result).toBeDefined()
  return result!
}

describe("Copilot collaboration compatibility", () => {
  test("identifies only newly emitted plaintext message arguments, never replayed input", () => {
    const adapter = prepare()
    const expected = JSON.parse(call().arguments) as { message: string }
    expect(adapter.plaintextMessages(adapter.payload)).toEqual([])
    expect(
      adapter.plaintextMessages({
        output: [
          call("other"),
          { ...call(adapter.namespace), name: "wait_agent" },
        ],
      }),
    ).toEqual([])
    expect(
      adapter.plaintextMessages({
        response: { output: [call(adapter.namespace)] },
      }),
    ).toEqual([expected.message])
    expect(
      adapter.plaintextMessages({ output: [call(adapter.namespace)] }),
    ).toEqual([])
  })

  test("tracks interleaved call IDs before argument-done events are forwarded", () => {
    const adapter = prepare()
    const first = { ...call(adapter.namespace), arguments: "" }
    const second = { ...first, id: "fc_2", name: "send_message" }
    expect(
      adapter.plaintextMessages({
        type: "response.output_item.added",
        output_index: 0,
        item: first,
      }),
    ).toEqual([])
    expect(
      adapter.plaintextMessages({
        type: "response.output_item.added",
        output_index: 1,
        item: second,
      }),
    ).toEqual([])
    expect(
      adapter.plaintextMessages({
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        namespace: "other",
        name: "spawn_agent",
        arguments: '{"message":"not ours"}',
      }),
    ).toEqual([])
    expect(
      adapter.plaintextMessages({
        type: "response.function_call_arguments.done",
        item_id: "fc_1",
        name: "other_tool",
        arguments: '{"message":"not ours"}',
      }),
    ).toEqual([])
    expect(
      adapter.plaintextMessages({
        type: "response.function_call_arguments.done",
        item_id: "fc_2",
        name: "send_message",
        arguments: '{"message":"second"}',
      }),
    ).toEqual(["second"])
    expect(
      adapter.plaintextMessages({
        type: "response.function_call_arguments.done",
        output_index: 0,
        name: "spawn_agent",
        arguments: '{"message":"first"}',
      }),
    ).toEqual(["first"])
    expect(
      adapter.plaintextMessages({
        type: "response.function_call_arguments.done",
        name: `${adapter.namespace}.followup_task`,
        arguments: '{"message":"followup"}',
      }),
    ).toEqual(["followup"])
  })

  test("ignores incomplete, malformed, and unrelated argument carriers", () => {
    const adapter = prepare()
    for (const args of [
      undefined,
      "",
      "{",
      "null",
      "[]",
      '{"message":12}',
      "{}",
    ]) {
      expect(
        adapter.plaintextMessages({
          ...call(adapter.namespace),
          arguments: args,
        }),
      ).toEqual([])
    }
    expect(adapter.plaintextMessages(null)).toEqual([])
    expect(
      adapter.plaintextMessages({
        type: "response.function_call_arguments.done",
        name: "spawn_agent",
        item_id: "unknown",
        arguments: '{"message":"unknown"}',
      }),
    ).toEqual([])
    expect(
      adapter.plaintextMessages({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "custom_tool_call",
          namespace: adapter.namespace,
          name: "spawn_agent",
          id: "custom",
        },
      }),
    ).toEqual([])
    expect(
      adapter.plaintextMessages({
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: '{"message":"unknown"}',
      }),
    ).toEqual([])
  })

  test("is a no-op without collaboration definitions", () => {
    for (const payload of [
      { model: "gpt-test" },
      { model: "gpt-test", input: "hello", tools: null },
      { model: "gpt-test", input: [call()] },
      {
        model: "gpt-test",
        tools: [{ type: "function", name: "spawn_agent", parameters: null }],
      },
      {
        model: "gpt-test",
        tools: [{ type: "namespace", name: "collaboration_extra", tools: [] }],
      },
    ]) {
      const original = structuredClone(payload)
      expect(createCollaborationCompatibility(payload)).toBeUndefined()
      expect(payload).toEqual(original)
    }
  })

  test.each(["top-level", "additional_tools", "tool_search_output"])(
    "adapts %s schemas and restores all original annotations",
    (location) => {
      const originalTools = [namespace(), { ...namespace(), name: "other" }]
      const payload: ResponsesPayload =
        location === "top-level" ?
          { model: "gpt-test", tools: originalTools }
        : {
            model: "gpt-test",
            input: [{ type: location, tools: originalTools }],
          }
      const original = structuredClone(payload)
      const adapter = prepare(payload)
      const expected = structuredClone(originalTools)
      expected[0].name = adapter.namespace
      for (const tool of expected[0].tools.slice(0, 3)) {
        if (tool.parameters && "properties" in tool.parameters) {
          delete tool.parameters.properties.message.encrypted
        }
      }
      const forwarded =
        location === "top-level" ?
          adapter.payload.tools
        : (adapter.payload.input as Array<{ tools: unknown }>)[0].tools
      expect(forwarded).toEqual(expected)
      expect(adapter.restoreResponse({ tools: forwarded })).toEqual({
        tools: originalTools,
      })
      expect(payload).toEqual(original)
    },
  )

  test("preserves argument bytes, call IDs, reasoning, agent messages, and ordinary tools", () => {
    const payload = request()
    const before = structuredClone(payload)
    const adapter = prepare(payload)
    const items = adapter.payload.input as Array<Record<string, unknown>>
    const originalItems = before.input as Array<Record<string, unknown>>
    expect(items[3]).toEqual({
      ...originalItems[3],
      namespace: adapter.namespace,
    })
    for (const index of [1, 2, 4, 5, 6])
      expect(items[index]).toEqual(originalItems[index])
    expect(adapter.restoreResponse(adapter.payload)).toEqual(before)
    expect(payload).toEqual(before)
  })

  test("retains opaque legacy message values without inventing plaintext", () => {
    const payload = request()
    const items = payload.input as Array<Record<string, unknown>>
    const opaque = "opaque-legacy-ciphertext-copilot_collaboration"
    items[3].arguments = JSON.stringify({ message: opaque })
    items.push({
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: opaque }],
    })
    const adapter = prepare(payload)
    const mappedItems = adapter.payload.input as Array<Record<string, unknown>>
    expect(mappedItems[3].arguments).toBe(items[3].arguments)
    expect(mappedItems.at(-1)).toEqual(items.at(-1))
  })

  test("avoids aliases already used by definitions, history, or explicit choices", () => {
    const payload = request()
    payload.tools = [
      { type: "namespace", name: "copilot_collaboration", tools: [] },
    ]
    ;(payload.input as Array<Record<string, unknown>>).push(
      call("copilot_collaboration_1"),
    )
    payload.tool_choice = {
      type: "function",
      name: "copilot_collaboration_2.spawn_agent",
    }
    const adapter = prepare(payload)
    expect(adapter.namespace).toBe("copilot_collaboration_3")
    expect(adapter.payload.tools).toEqual(payload.tools)
    expect(
      (adapter.payload.input as Array<Record<string, unknown>>).at(-1),
    ).toEqual(call("copilot_collaboration_1"))
    expect(adapter.payload.tool_choice).toEqual(payload.tool_choice)
    expect(prepare(payload).namespace).toBe(adapter.namespace)
    expect(createCollaborationCompatibility(adapter.payload)).toBeUndefined()
  })

  test.each(["auto", "none", "required"] as const)(
    "preserves tool_choice=%s",
    (choice) => {
      const payload = request()
      payload.tool_choice = choice
      expect(prepare(payload).payload.tool_choice).toBe(choice)
    },
  )

  test("maps namespaced and qualified explicit tool choices and restores them", () => {
    const choices = [
      { type: "function", name: "spawn_agent", namespace: "collaboration" },
      { type: "function", name: "collaboration.spawn_agent" },
      { type: "namespace", name: "collaboration" },
      {
        type: "allowed_tools",
        mode: "required",
        tools: [
          { type: "namespace", name: "collaboration" },
          { type: "function", name: "collaboration.send_message" },
          { type: "function", name: "other.send_message" },
        ],
      },
    ]
    for (const choice of choices) {
      // Additional tool-choice forms can arrive before the shared API types
      // model them; the adapter intentionally handles them structurally.
      const payload = {
        ...request(),
        tool_choice: choice,
      } as unknown as ResponsesPayload
      const adapter = prepare(payload)
      expect(JSON.stringify(adapter.payload.tool_choice)).toContain(
        adapter.namespace,
      )
      const restored: unknown = adapter.restoreResponse({
        tool_choice: adapter.payload.tool_choice,
      })
      expect(restored).toEqual({ tool_choice: choice })
    }
  })

  test("handles flat qualified definitions and calls", () => {
    const payload: ResponsesPayload = {
      model: "gpt-test",
      tools: [messageTool("collaboration.spawn_agent")],
      input: [
        { ...call(), namespace: undefined, name: "collaboration.spawn_agent" },
      ],
    }
    const adapter = prepare(payload)
    expect((adapter.payload.tools?.[0] as { name: string }).name).toBe(
      `${adapter.namespace}.spawn_agent`,
    )
    expect(
      (adapter.payload.input as Array<Record<string, unknown>>)[0].name,
    ).toBe(`${adapter.namespace}.spawn_agent`)
    expect(adapter.restoreResponse(adapter.payload)).toEqual(payload)
  })

  test("restores false and absent annotations without adding encryption to other fields", () => {
    for (const annotation of [false, undefined]) {
      const tool = messageTool("spawn_agent", false)
      if (annotation === undefined)
        delete tool.parameters.properties.message.encrypted
      const payload: ResponsesPayload = {
        model: "gpt-test",
        tools: [{ ...namespace(), tools: [tool] }],
      }
      const adapter = prepare(payload)
      expect(adapter.restoreResponse({ tools: adapter.payload.tools })).toEqual(
        { tools: payload.tools },
      )
    }
  })

  test("handles repeated definitions and malformed optional schema fields", () => {
    const payload = request()
    payload.tools = [
      {
        ...namespace(),
        tools: [
          null,
          {
            type: "function",
            name: "spawn_agent",
            parameters: { properties: { message: null } },
          },
        ],
      },
    ]
    ;(payload.input as Array<Record<string, unknown>>).push({
      type: "additional_tools",
      tools: [null, namespace()],
    })
    const adapter = prepare(payload)
    expect(adapter.restoreResponse(adapter.payload)).toEqual(payload)
    expect(
      prepare({
        model: "gpt-test",
        tools: [{ type: "namespace", name: "collaboration", tools: null }],
      }).payload.tools?.[0] as { name: string },
    ).not.toMatchObject({ name: "collaboration" })
  })

  test("restores streaming and terminal call metadata with interleaved argument deltas intact", () => {
    const adapter = prepare()
    const upstreamCall = call(adapter.namespace)
    const chunks = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...upstreamCall, arguments: "" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          ...upstreamCall,
          call_id: "call_2",
          id: "fc_2",
          name: "send_message",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc_1",
        delta: '{"message":"copilot_collaboration 😀',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: "fc_2",
        delta: "other delta",
      },
      {
        type: "response.function_call_arguments.done",
        name: `${adapter.namespace}.spawn_agent`,
        arguments: upstreamCall.arguments,
        item_id: "fc_1",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: upstreamCall,
      },
      {
        type: "response.completed",
        response: {
          output: [upstreamCall],
          tools: (adapter.payload.input as Array<{ tools?: unknown }>)[0].tools,
        },
      },
    ].map((event, index) => ({
      id: `sse_${index}`,
      event: event.type,
      data: JSON.stringify(event),
    }))

    const restored = chunks.map((chunk) => adapter.restoreChunk(chunk))
    expect(restored[2]).toBe(chunks[2])
    expect(restored[3]).toBe(chunks[3])
    const parsed = restored.map(
      (chunk) => JSON.parse(chunk.data) as Record<string, unknown>,
    )
    expect(parsed[0].item).toEqual({ ...call(), arguments: "" })
    expect(parsed[1].item).toEqual({
      ...call(),
      call_id: "call_2",
      id: "fc_2",
      name: "send_message",
    })
    expect(parsed[4]).toEqual({
      ...(JSON.parse(chunks[4].data) as Record<string, unknown>),
      name: "collaboration.spawn_agent",
    })
    expect(parsed[5].item).toEqual(call())
    expect(parsed[6].response).toEqual({
      output: [call()],
      tools: [namespace()],
    })
    expect(restored.map((chunk) => chunk.id)).toEqual(
      chunks.map((chunk) => chunk.id),
    )
  })

  test("restores native namespace fields in argument-done events and nested discovered tools", () => {
    const adapter = prepare()
    const event = {
      type: "response.function_call_arguments.done",
      namespace: adapter.namespace,
      name: "spawn_agent",
      arguments: "opaque arguments",
    }
    expect(adapter.restoreResponse(event)).toEqual({
      ...event,
      namespace: "collaboration",
    })
    expect(
      adapter.restoreResponse({
        type: "response.output_item.done",
        item: {
          type: "tool_search_output",
          tools: [{ ...namespace(), name: adapter.namespace }],
        },
      }),
    ).toEqual({
      type: "response.output_item.done",
      item: { type: "tool_search_output", tools: [namespace()] },
    })
  })

  test("does not rewrite arbitrary nested values or malformed stream chunks", () => {
    const adapter = prepare()
    for (const chunk of [
      {},
      { data: "" },
      { data: "[DONE]" },
      { data: "not JSON" },
      { data: "null" },
      { data: "[]" },
      {
        data: JSON.stringify({
          type: "message",
          text: adapter.namespace,
          metadata: { namespace: adapter.namespace },
        }),
      },
    ])
      expect(adapter.restoreChunk(chunk)).toBe(chunk)
    for (const value of [
      null,
      undefined,
      "string",
      1,
      [call(adapter.namespace)],
    ]) {
      expect(adapter.restoreResponse(value)).toBe(value)
    }
    const response = {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: adapter.namespace }],
        },
      ],
    }
    expect(adapter.restoreResponse(response)).toBe(response)
  })
})
