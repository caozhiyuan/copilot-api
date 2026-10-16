import { describe, expect, test } from "bun:test"

import type { AnthropicResponse } from "~/lib/types/anthropic"
import type { ResponsesPayload, Tool } from "~/lib/types/responses"
import {
  translateAnthropicToResponses,
  translateResponsesToMessages,
} from "~/routes/responses/messages-translation"
import { translateMessagesStream } from "~/routes/responses/messages-stream-translation"

type Kind = "custom" | "function"
const source = 'text("hello")'
const args = { command: "echo hello" }
const tool = (kind: Kind, name = "exec"): Tool =>
  kind === "custom" ?
    { type: kind, name, format: { type: "text" } }
  : { type: kind, name, parameters: { type: "object" }, strict: false }
const namespace = (name: string, tools: Array<Tool>): Tool => ({
  type: "namespace",
  name,
  tools,
})
const history = (kind: Kind, ns?: string | null, name = "exec") => ({
  call_id: "call-history",
  name,
  namespace: ns,
  ...(kind === "custom" ?
    { type: "custom_tool_call" as const, input: source }
  : { type: "function_call" as const, arguments: JSON.stringify(args) }),
})
const translate = (
  payload: Omit<ResponsesPayload, "model">,
  toolCallTips = false,
) =>
  translateResponsesToMessages(
    { model: "claude-test", max_output_tokens: 64, ...payload },
    { model: "claude-test", toolCallTips },
  )
const historyName = (result: ReturnType<typeof translate>) => {
  for (const message of result.messagesPayload.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue
    const block = message.content.find((part) => part.type === "tool_use")
    if (block) return block.name
  }
  return undefined
}
const response = (name: string, kind: Kind): AnthropicResponse => ({
  id: "msg_tool",
  model: "claude-test",
  role: "assistant",
  type: "message",
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
  content: [
    {
      type: "tool_use",
      id: "call-output",
      name,
      input: kind === "custom" ? { input: source } : args,
    },
  ],
})

describe("Responses Messages default tool namespace", () => {
  for (const kind of ["custom", "function"] as const) {
    for (const inputTools of [false, true]) {
      test.each([undefined, null, "", "functions"])(
        `${kind} tools from ${inputTools ? "additional_tools" : "tools"} reuse the default alias for namespace %j`,
        (ns) => {
          const tools = [
            namespace("functions", [tool(kind)]),
            namespace("sandbox", [tool(kind)]),
          ]
          const result = translate({
            tools: inputTools ? [] : tools,
            input: [
              ...(inputTools ?
                [{ type: "additional_tools", role: "developer", tools }]
              : []),
              { role: "user", content: "Run it" },
              history(kind, ns),
            ],
            tool_choice: { type: kind, name: "exec", namespace: ns },
          })
          expect(
            result.messagesPayload.tools?.map((entry) => entry.name),
          ).toEqual(["exec", "sandbox__exec"])
          expect(historyName(result)).toBe("exec")
          expect(result.messagesPayload.tool_choice).toEqual({
            type: "tool",
            name: "exec",
          })
          expect(
            translateAnthropicToResponses(response("exec", kind), result)
              .output[0],
          ).toMatchObject({
            type: kind === "custom" ? "custom_tool_call" : "function_call",
            call_id: "call-output",
            namespace: "functions",
            name: "exec",
            ...(kind === "custom" ?
              { input: source }
            : { arguments: JSON.stringify(args) }),
          })
        },
      )
    }

    test(`${kind} history and tool choices do not infer a non-default namespace`, () => {
      const tools = [namespace("sandbox", [tool(kind)])]
      const result = translate({ tools, input: [history(kind)] })
      expect(result.messagesPayload.tools?.map((entry) => entry.name)).toEqual([
        "sandbox__exec",
      ])
      expect(historyName(result)).toBe("exec")
      expect(() =>
        translate({
          tools,
          input: "Run it",
          tool_choice: { type: kind, name: "exec" },
        }),
      ).toThrow("tool_choice references unknown")
      const explicit = translate({
        tools,
        input: [history(kind, "sandbox")],
        tool_choice: { type: kind, name: "exec", namespace: "sandbox" },
      })
      expect(historyName(explicit)).toBe("sandbox__exec")
      expect(explicit.messagesPayload.tool_choice?.name).toBe("sandbox__exec")
    })

    test(`${kind} calls with explicit functions can reuse a top-level declaration`, () => {
      const result = translate({
        tools: [tool(kind)],
        input: [history(kind, "functions")],
        tool_choice: { type: kind, name: "exec", namespace: "functions" },
      })
      expect(historyName(result)).toBe("exec")
      expect(result.messagesPayload.tool_choice?.name).toBe("exec")
      expect(
        translateAnthropicToResponses(response("exec", kind), result).output[0],
      ).not.toHaveProperty("namespace")
    })
  }

  test("does not map an explicit unknown namespace or the wrong tool kind", () => {
    const tools = [namespace("functions", [tool("custom")])]
    expect(
      historyName(translate({ tools, input: [history("custom", "sandbox")] })),
    ).toBe("sandbox__exec")
    const wrongKind = translate({ tools, input: [history("function")] })
    expect(historyName(wrongKind)).not.toBe("exec")
    expect(wrongKind.messagesPayload.tools).toHaveLength(1)
    expect(() =>
      translate({
        tools,
        input: "Run it",
        tool_choice: { type: "function", name: "exec" },
      }),
    ).toThrow("tool_choice references unknown")
  })

  test.each([false, true])(
    "keeps exact top-level identity when default aliases collide, reversed=%j",
    (reverse) => {
      const tools = [tool("custom"), namespace("functions", [tool("custom")])]
      if (reverse) tools.reverse()
      const result = translate({ tools, input: [history("custom")] })
      const aliases =
        result.messagesPayload.tools?.map((entry) => entry.name) ?? []
      expect(new Set(aliases).size).toBe(2)
      const topLevelAlias = aliases[reverse ? 1 : 0]
      const defaultAlias = aliases[reverse ? 0 : 1]
      expect(historyName(result)).toBe(topLevelAlias)
      expect(
        historyName(
          translate({ tools, input: [history("custom", "functions")] }),
        ),
      ).toBe(defaultAlias)
      expect(
        translateAnthropicToResponses(response(topLevelAlias, "custom"), result)
          .output[0],
      ).not.toHaveProperty("namespace")
      expect(
        translateAnthropicToResponses(response(defaultAlias, "custom"), result)
          .output[0],
      ).toMatchObject({
        name: "exec",
        namespace: "functions",
        type: "custom_tool_call",
      })
    },
  )

  test.each([false, true])(
    "reuses registered aliases for flattened-name collisions, reversed=%j",
    (reverse) => {
      const tools = [
        namespace("functions", [tool("custom", "sandbox__exec")]),
        namespace("sandbox", [tool("custom")]),
      ]
      if (reverse) tools.reverse()
      const result = translate({
        tools,
        input: [history("custom", "sandbox")],
        tool_choice: { type: "custom", name: "exec", namespace: "sandbox" },
      })
      const aliases =
        result.messagesPayload.tools?.map((entry) => entry.name) ?? []
      expect(new Set(aliases).size).toBe(2)
      const alias = aliases[reverse ? 0 : 1]
      expect(historyName(result)).toBe(alias)
      expect(result.messagesPayload.tool_choice?.name).toBe(alias)
      expect(
        translateAnthropicToResponses(response(alias, "custom"), result)
          .output[0],
      ).toMatchObject({
        name: "exec",
        namespace: "sandbox",
        type: "custom_tool_call",
        input: source,
      })
    },
  )

  test.each(["bad.name", "x".repeat(80)])(
    "reuses sanitized default aliases for %s",
    (name) => {
      const result = translate({
        tools: [namespace("functions", [tool("custom", name)])],
        input: [history("custom", undefined, name)],
      })
      const alias = result.messagesPayload.tools?.[0].name ?? ""
      expect(alias).toMatch(/^[A-Za-z0-9_-]{1,64}$/u)
      expect(historyName(result)).toBe(alias)
      expect(
        translateAnthropicToResponses(response(alias, "custom"), result)
          .output[0],
      ).toMatchObject({
        name,
        namespace: "functions",
        type: "custom_tool_call",
      })
    },
  )

  test("retains nested namespace prefixes", () => {
    const result = translate({
      tools: [namespace("functions", [namespace("nested", [tool("custom")])])],
      input: [history("custom", "functions.nested")],
    })
    expect(result.messagesPayload.tools?.[0].name).toBe(
      "functions_nested__exec",
    )
    expect(historyName(result)).toBe("functions_nested__exec")
  })

  test("uses actual exec and wait aliases in regular, retry and batch guidance", () => {
    const result = translate(
      {
        tools: [
          tool("function"),
          tool("custom", "wait"),
          namespace("functions", [tool("custom"), tool("function", "wait")]),
        ],
        input: "Run it",
        parallel_tool_calls: false,
      },
      true,
    )
    const aliases =
      result.messagesPayload.tools?.map((entry) => entry.name) ?? []
    expect(aliases[2]).toMatch(/^tool_/u)
    expect(aliases[3]).toMatch(/^tool_/u)
    const system = result.messagesPayload.system
    expect(Array.isArray(system)).toBe(true)
    const tips =
      Array.isArray(system) ? system.map((block) => block.text).join("\n") : ""
    expect(tips).toContain(`Use \`${aliases[2]}\` to run commands`)
    expect(tips).toContain(`If \`${aliases[2]}\` returns`)
    expect(tips).toContain(`in one \`${aliases[2]}\` call`)
    expect(tips).toContain(`with \`${aliases[3]}\``)
    expect(tips).toContain("tools.exec_command")
    expect(tips).toContain("tools.write_stdin")
    expect(tips).not.toContain("functions__exec")
  })

  test.each([false, true])(
    "streams the original custom identity after aliasing, collision=%j",
    async (collision) => {
      const tools = [namespace("functions", [tool("custom")])]
      if (collision) tools.unshift(tool("function"))
      const result = translate({ tools, input: "Run it", stream: true })
      const alias = result.messagesPayload.tools?.at(-1)?.name
      expect(alias).toBeDefined()
      async function* chunks() {
        await Promise.resolve()
        const message = response(alias!, "custom")
        yield {
          data: JSON.stringify({
            type: "message_start",
            message: { ...message, content: [], stop_reason: null },
          }),
        }
        yield {
          data: JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { ...message.content[0], input: {} },
          }),
        }
        yield {
          data: JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({ input: source }),
            },
          }),
        }
        yield { data: JSON.stringify({ type: "content_block_stop", index: 0 }) }
        yield { data: JSON.stringify({ type: "message_stop" }) }
      }
      const events = []
      for await (const event of translateMessagesStream(chunks(), result))
        events.push(event)
      const items = events.flatMap((event) =>
        (
          event.type === "response.output_item.added"
          || event.type === "response.output_item.done"
        ) ?
          [event.item]
        : [],
      )
      expect(items).toHaveLength(2)
      for (const item of items)
        expect(item).toMatchObject({
          type: "custom_tool_call",
          name: "exec",
          namespace: "functions",
          call_id: "call-output",
        })
      expect(items[1]).toMatchObject({ input: source, status: "completed" })
      expect(
        events
          .filter(
            (event) => event.type === "response.custom_tool_call_input.delta",
          )
          .map((event) => event.delta)
          .join(""),
      ).toBe(source)
      expect(events.at(-1)?.type).toBe("response.completed")
    },
  )
})
