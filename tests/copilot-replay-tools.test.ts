import { describe, expect, spyOn, test } from "bun:test"

import { restoreCopilotReplayTools } from "~/lib/copilot-replay-tools"
import { HTTPError } from "~/lib/http/error"
import type {
  ResponseFunctionToolCallItem,
  ResponseInputItem,
  ResponsesPayload,
} from "~/lib/types/responses"

import { collaborationReplayTools } from "./fixtures/collaboration-replay-tools"

const ciphertext = `gAAAA${"S".repeat(45)}`
const encryptedCall = (): ResponseFunctionToolCallItem => ({
  type: "function_call",
  name: "followup_task",
  namespace: "collaboration",
  call_id: "synthetic-call",
  arguments: JSON.stringify({
    target: "synthetic",
    message: ciphertext,
    _oai_encrypted: true,
  }),
})
const encryptedAgentMessage = (): ResponseInputItem => ({
  type: "agent_message",
  author: "synthetic-parent",
  recipient: "synthetic-child",
  content: [{ type: "encrypted_content", encrypted_content: ciphertext }],
})
const payload = (
  item: ResponseInputItem = encryptedCall(),
): ResponsesPayload => ({
  model: "gpt-test",
  input: [item],
  tools: [],
  tool_choice: "auto",
  parallel_tool_calls: true,
  stream: true,
  reasoning: { effort: "max" },
  include: ["output.encrypted_content", "reasoning.encrypted_content"],
})
const catalog = () => [structuredClone(collaborationReplayTools)]

describe("Copilot encrypted tool history replay", () => {
  test("is disabled without an explicitly configured original catalog", () => {
    const request = payload()
    expect(restoreCopilotReplayTools(request, undefined)).toBe(request)
  })

  test.each([undefined, null, []].map((tools) => ({ tools })))(
    "restores tool-less replay with tools %j and never changes history",
    ({ tools }) => {
      const request = { ...payload(), tools }
      const before = JSON.stringify(request)
      const restored = restoreCopilotReplayTools(request, catalog())
      expect(restored).not.toBe(request)
      expect(restored.tools).toEqual(catalog())
      expect(restored.tool_choice).toBe("none")
      expect(restored.parallel_tool_calls).toBe(false)
      expect(restored.input).toBe(request.input)
      expect(restored.reasoning).toBe(request.reasoning)
      expect(restored.include).toBe(request.include)
      expect(restored.stream).toBe(true)
      expect(JSON.stringify(request)).toBe(before)
    },
  )

  test.each(["none", "auto", undefined] as const)(
    "prohibits calls when the original tool choice is %j",
    (toolChoice) => {
      expect(
        restoreCopilotReplayTools(
          { ...payload(), tool_choice: toolChoice },
          catalog(),
        ).tool_choice,
      ).toBe("none")
    },
  )

  test.each([
    "required",
    { type: "function", name: "followup_task" },
    { type: "custom", name: "synthetic" },
  ] as const)(
    "does not change an explicit executable tool choice %j",
    (toolChoice) => {
      const request: ResponsesPayload = {
        ...payload(),
        tool_choice: toolChoice,
      }
      expect(restoreCopilotReplayTools(request, catalog())).toBe(request)
    },
  )

  test("restores declarations for encrypted agent messages without parsing ciphertext", () => {
    const request = payload(encryptedAgentMessage())
    expect(restoreCopilotReplayTools(request, catalog()).tools).toEqual(
      catalog(),
    )
  })

  test.each([
    { role: "user", content: "plain short chat" },
    { type: "reasoning", encrypted_content: ciphertext, summary: [] },
    { type: "compaction", encrypted_content: ciphertext },
    {
      type: "agent_message",
      content: [{ type: "input_text", text: "plain message" }],
    },
    {
      type: "agent_message",
      content: [{ type: "encrypted_content", encrypted_content: "" }],
    },
    { type: "function_call", arguments: "{}", name: "plain" },
    { type: "function_call", arguments: 123, name: "plain" },
  ])("leaves non-encrypted-tool input %j unchanged", (item) => {
    const request = payload(item)
    expect(restoreCopilotReplayTools(request, catalog())).toBe(request)
  })

  test.each(["hello", undefined])(
    "leaves non-array input %j unchanged",
    (input) => {
      const request: ResponsesPayload = { ...payload(), input }
      expect(restoreCopilotReplayTools(request, catalog())).toBe(request)
    },
  )

  test("keeps authoritative request tools even if fallback configuration is invalid", () => {
    const request = { ...payload(), tools: catalog() }
    expect(restoreCopilotReplayTools(request, [null])).toBe(request)
  })

  test.each(["additional_tools", "tool_search_output"])(
    "keeps authoritative %s history catalogs",
    (type) => {
      const request = {
        ...payload(),
        input: [encryptedCall(), { type, tools: catalog() }],
      }
      expect(restoreCopilotReplayTools(request, [null])).toBe(request)
    },
  )

  test.each([
    { ...encryptedCall(), arguments: ciphertext },
    { ...encryptedCall(), encrypted_content: ciphertext, arguments: "{}" },
    {
      ...encryptedCall(),
      encrypted_function_args: ciphertext,
      arguments: "{}",
    },
    {
      ...encryptedCall(),
      arguments: JSON.stringify({ nested: [{ message: ciphertext }] }),
    },
  ])("recognizes portable encrypted argument shape %j", (item) => {
    expect(
      restoreCopilotReplayTools(payload(item), catalog()).tool_choice,
    ).toBe("none")
  })

  test("keeps the encryption marker and optional tool metadata intact", () => {
    const original = catalog()
    const declaration = original[0].tools[0]
    const configured = [
      {
        ...original[0],
        tools: [{ ...declaration, output_schema: { type: "string" } }],
      },
    ]
    expect(restoreCopilotReplayTools(payload(), configured).tools).toEqual(
      configured,
    )
    expect(restoreCopilotReplayTools(payload(), original).tools).not.toBe(
      original,
    )
  })

  test("supports original functions in the default namespace", () => {
    const declaration = collaborationReplayTools.tools[0]
    const request = payload({ ...encryptedCall(), namespace: "functions" })
    expect(restoreCopilotReplayTools(request, [declaration]).tools).toEqual([
      declaration,
    ])
  })

  test.each(
    [
      [],
      null,
      [null],
      [{ type: "namespace", name: "collaboration", tools: [] }],
      [{ ...collaborationReplayTools, description: "" }],
      [{ type: "function", name: "wrong", parameters: {}, strict: false }],
      [collaborationReplayTools, collaborationReplayTools],
      [
        {
          ...collaborationReplayTools,
          tools: [
            collaborationReplayTools.tools[0],
            collaborationReplayTools.tools[0],
          ],
        },
      ],
      [collaborationReplayTools.tools[0], collaborationReplayTools.tools[0]],
    ].map((configured) => ({ configured })),
  )(
    "rejects invalid or incomplete configured declarations %j without changing the request",
    ({ configured }) => {
      const request = payload()
      const before = JSON.stringify(request)
      expect(() => restoreCopilotReplayTools(request, configured)).toThrow(
        HTTPError,
      )
      expect(JSON.stringify(request)).toBe(before)
    },
  )

  test("provides a structured explicit error instead of forwarding a guessed schema", async () => {
    try {
      restoreCopilotReplayTools(payload(), [])
      throw new Error("Expected configuration error")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      if (!(error instanceof HTTPError)) throw error
      expect(error.response.status).toBe(500)
      const body: unknown = await error.response.json()
      expect(body).toMatchObject({
        error: { type: "configuration_error", code: "invalid_replay_tools" },
      })
    }
  })

  test("keeps malformed arguments for upstream validation with a content-free warning", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const request = payload({
        type: "function_call",
        name: "synthetic",
        arguments: "{",
      })
      expect(restoreCopilotReplayTools(request, catalog())).toBe(request)
    } finally {
      warning.mockRestore()
    }
  })
})
