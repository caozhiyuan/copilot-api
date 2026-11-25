import { expect, mock, test } from "bun:test"
import { events } from "fetch-event-stream"

import { requestContext, type RequestTiming } from "~/lib/http/request-context"
import type { ImageGenerationCall } from "~/lib/types/responses"
import type { ImageToolBridge } from "~/routes/responses/image-tool"
import { bridgeImageToolStream } from "~/routes/responses/image-tool-stream"

const name = "private_image_tool"
const tool = { type: "function", name }
const headers = { "content-type": "text/event-stream", "x-upstream": "yes" }
const functionItem = (index: number, args = "", toolName = name) => ({
  type: "function_call",
  id: `fc_${index}`,
  call_id: `call_${index}`,
  name: toolName,
  arguments: args,
})
const itemFrame = (when: "added" | "done", index: number, item: unknown) => ({
  type: `response.output_item.${when}`,
  output_index: index,
  item,
})
const life = (status: string, output: Array<unknown> = []) => ({
  type: `response.${status}`,
  response: {
    object: "response",
    id: "resp_upstream",
    status,
    output,
    tools: [tool],
  },
})
const encode = (event: unknown) => `data: ${JSON.stringify(event)}\r\n\r\n`
const source = (...frames: Array<unknown>) =>
  new Response(frames.map(encode).join(""), { headers })
const result = (id: string, b64 = "cG5n"): ImageGenerationCall => ({
  type: "image_generation_call",
  id,
  result: b64,
  status: "completed",
})
function makeBridge(
  implementation: ImageToolBridge["run"] = (_args, id) =>
    Promise.resolve(result(id)),
) {
  return {
    name,
    run: mock(implementation),
    restoreTools(response: Record<string, unknown>) {
      response.tools = [{ type: "image_generation" }]
    },
  }
}
type WireItem = {
  type: string
  id: string
  name?: string
  arguments?: string
  result?: string | null
  status?: string
}
type WireEvent = {
  type: string
  sequence_number: number
  output_index?: number
  item?: WireItem
  item_id?: string
  response?: {
    id: string
    output: Array<WireItem>
    tools: Array<unknown>
    error?: { code: string }
  }
}
async function collect(response: Response) {
  const received: Array<WireEvent> = []
  for await (const frame of events(response)) {
    if (frame.data && frame.data !== "[DONE]")
      received.push(JSON.parse(frame.data) as WireEvent)
  }
  return received
}
const wrap = (
  response: Response,
  bridge = makeBridge(),
  signal = new AbortController().signal,
) => bridgeImageToolStream(response, bridge, signal)

test("streams ordinary tools and turns the hidden call into one native image with progress and a terminal result", async () => {
  const args = '{"prompt":"private image prompt"}'
  const other = functionItem(0, '{"path":"README.md"}', "read_file")
  const hidden = functionItem(1)
  const bridge = makeBridge(async (_args, id, _signal, partial) => {
    await partial?.(0, "cHJldmlldw==")
    return result(id)
  })
  const output = wrap(
    source(
      life("created"),
      itemFrame("added", 0, other),
      itemFrame("added", 1, hidden),
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: other.id,
        delta: other.arguments,
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        item_id: hidden.id,
        delta: args,
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 1,
        item_id: hidden.id,
        arguments: args,
        name,
      },
      itemFrame("done", 1, { ...hidden, arguments: args }),
      itemFrame("done", 1, { ...hidden, arguments: args }),
      itemFrame("done", 0, other),
      life("completed"),
      life("completed"),
    ),
    bridge,
  )
  expect(output.headers.get("x-upstream")).toBe("yes")
  const received = await collect(output)
  expect(bridge.run).toHaveBeenCalledTimes(1)
  const [actualArgs, id] = bridge.run.mock.calls[0]
  expect(actualArgs).toBe(args)
  expect(id).toMatch(/^ig_/u)
  expect(received[0].response?.tools).toEqual([{ type: "image_generation" }])
  expect(received.filter((e) => e.output_index === 1)).toMatchObject([
    {
      type: "response.output_item.added",
      item: {
        type: "image_generation_call",
        id,
        result: "",
        status: "in_progress",
      },
    },
    { type: "response.image_generation_call.in_progress", item_id: id },
    { type: "response.image_generation_call.generating", item_id: id },
    {
      type: "response.image_generation_call.partial_image",
      item_id: id,
      partial_image_index: 0,
      partial_image_b64: "cHJldmlldw==",
    },
    { type: "response.image_generation_call.completed", item_id: id },
    { type: "response.output_item.done", item: result(id) },
  ])
  expect(
    received.filter((e) => e.output_index === 0).map((e) => e.type),
  ).toEqual([
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.output_item.done",
  ])
  expect(received.at(-1)?.response?.output).toEqual([other, result(id)])
  expect(received.map((e) => e.sequence_number)).toEqual(
    received.map((_, i) => i),
  )
  expect(JSON.stringify(received)).not.toContain(name)
  expect(JSON.stringify(received)).not.toContain("private image prompt")
})

test("recognizes completed-only calls, runs them concurrently and preserves output order", async () => {
  const first = Promise.withResolvers<void>()
  const bridge = makeBridge(async (args, id) => {
    if (args === "first") await first.promise
    else first.resolve()
    return result(id, args)
  })
  const reasoning = { type: "reasoning", id: "rs", summary: [] }
  const received = await collect(
    wrap(
      source(
        life("completed", [
          functionItem(0, "first"),
          reasoning,
          functionItem(2, "second"),
        ]),
      ),
      bridge,
    ),
  )
  expect(bridge.run).toHaveBeenCalledTimes(2)
  const [, id1] = bridge.run.mock.calls[0]
  const [, id2] = bridge.run.mock.calls[1]
  expect(id1).not.toBe(id2)
  expect(received.at(-1)?.response?.output).toEqual([
    result(id1, "first"),
    reasoning,
    result(id2, "second"),
  ])
})

test("passes text through before the model or image generation finishes", async () => {
  const input = new TransformStream<Uint8Array, Uint8Array>()
  const writer = input.writable.getWriter()
  const response = wrap(new Response(input.readable, { headers }))
  const downstream = events(response)
  const delta = {
    type: "response.output_text.delta",
    output_index: 0,
    delta: "progress",
  }
  await writer.write(new TextEncoder().encode(encode(delta)))
  const next = await downstream.next()
  expect(next.value && JSON.parse(next.value.data ?? "")).toMatchObject(delta)
  await writer.write(new TextEncoder().encode(encode(life("completed"))))
  await writer.close()
  for await (const _frame of downstream) {
    /* drain */
  }
})

test.each(["incomplete", "failed", "eof"])(
  "does not generate for upstream %s",
  async (status) => {
    const bridge = makeBridge()
    const hidden = functionItem(0, '{"prompt":"partial"}')
    const frames = [itemFrame("added", 0, hidden), itemFrame("done", 0, hidden)]
    const received = await collect(
      wrap(
        source(
          ...frames,
          ...(status === "eof" ? [] : [life(status, [hidden])]),
        ),
        bridge,
      ),
    )
    expect(bridge.run).not.toHaveBeenCalled()
    expect(received.at(-1)?.type).toBe(
      status === "incomplete" ? "response.incomplete" : "response.failed",
    )
    expect(received.at(-1)?.response?.output[0]).toMatchObject({
      type: "image_generation_call",
      status: "failed",
    })
    expect(JSON.stringify(received)).not.toContain(name)
  },
)

test("an unterminated item in a completed response is never executed", async () => {
  const bridge = makeBridge()
  const hidden = functionItem(0, "valid-but-unfinished")
  const received = await collect(
    wrap(source(itemFrame("added", 0, hidden), life("completed")), bridge),
  )
  expect(bridge.run).not.toHaveBeenCalled()
  expect(received.at(-1)?.type).toBe("response.failed")
})

test("counts a successful chat response followed by a failed image as a request failure", async () => {
  const timing: RequestTiming = {
    id: "req",
    firstTokenMs: null,
    durationMs: null,
    hasUsage: false,
    outcome: null,
    recordFirstToken() {},
  }
  const bridge = makeBridge(() =>
    Promise.reject(new Error("image unavailable")),
  )
  const response = requestContext.run(
    {
      traceId: "trace",
      startTime: Date.now(),
      userAgent: "codex",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      requestTiming: timing,
    },
    () => wrap(source(life("completed", [functionItem(0, "paint")])), bridge),
  )
  expect((await collect(response)).at(-1)?.type).toBe("response.failed")
  expect(timing.protocolFailed).toBe(true)
})

test("forwards a namespaced client function with the same name as the bridge", async () => {
  const bridge = makeBridge()
  const clientCall = {
    ...functionItem(0, "client arguments"),
    namespace: "workspace",
  }
  const done = {
    type: "response.function_call_arguments.done",
    output_index: 0,
    name,
    arguments: clientCall.arguments,
  }
  const received = await collect(
    wrap(
      source(
        done,
        itemFrame("added", 0, clientCall),
        itemFrame("done", 0, clientCall),
        life("completed", [clientCall]),
      ),
      bridge,
    ),
  )
  expect(bridge.run).not.toHaveBeenCalled()
  expect(received.find((frame) => frame.type === done.type)).toMatchObject(done)
  expect(received.at(-1)?.response?.output).toEqual([clientCall])
})

test.each([
  [itemFrame("done", 5, functionItem(5, "paint")), life("completed")],
  [life("completed", [functionItem(0, "paint"), functionItem(0, "paint")])],
  [itemFrame("done", -1, functionItem(0, "paint")), life("completed")],
  [
    itemFrame("added", 0, functionItem(0, "", "read_file")),
    itemFrame("done", 0, functionItem(0, "paint")),
  ],
  [
    { type: "error", message: "upstream failed" },
    life("completed", [functionItem(0, "paint")]),
  ],
])(
  "malformed output cannot trigger image generation (%#)",
  async (...frames) => {
    const bridge = makeBridge()
    const received = await collect(wrap(source(...frames), bridge))
    expect(bridge.run).not.toHaveBeenCalled()
    expect(received.at(-1)?.type).toBe("response.failed")
    expect(JSON.stringify(received)).not.toContain(name)
  },
)

test("withholds the function header when the upstream supplies its name late", async () => {
  const bridge = makeBridge()
  const hidden = functionItem(0, "hidden prompt")
  const received = await collect(
    wrap(
      source(
        itemFrame("added", 0, { ...hidden, name: "" }),
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: hidden.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: hidden.arguments,
          name,
        },
        itemFrame("done", 0, { ...hidden, name: "" }),
        life("completed"),
      ),
      bridge,
    ),
  )
  expect(bridge.run.mock.calls[0][0]).toBe("hidden prompt")
  expect(JSON.stringify(received)).not.toContain("hidden prompt")
  expect(received.at(-1)?.response?.output[0].type).toBe(
    "image_generation_call",
  )
})

test("a failed generation aborts siblings and closes the response without upstream error bodies", async () => {
  let siblingAborted = false
  const started = Promise.withResolvers<void>()
  const bridge = makeBridge(async (args, id, signal) => {
    if (args === "fails") {
      await started.promise
      throw new Error("private upstream body")
    }
    started.resolve()
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          siblingAborted = true
          resolve()
        },
        { once: true },
      ),
    )
    return result(id)
  })
  const received = await collect(
    wrap(
      source(
        life("completed", [functionItem(0, "fails"), functionItem(1, "waits")]),
      ),
      bridge,
    ),
  )
  expect(siblingAborted).toBe(true)
  expect(received.at(-1)).toMatchObject({
    type: "response.failed",
    response: { id: "resp_upstream", error: { code: "server_error" } },
  })
  expect(JSON.stringify(received)).not.toContain("private upstream body")
  expect(
    received.filter((e) => e.type === "response.output_item.done"),
  ).toHaveLength(2)
})

test("buffers unidentifiable argument deltas until their item is known", async () => {
  const bridge = makeBridge()
  const received = await collect(
    wrap(
      source(
        {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: "hidden prompt",
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: "public path",
        },
        itemFrame("added", 0, functionItem(0)),
        itemFrame("added", 1, functionItem(1, "", "read_file")),
        itemFrame("done", 0, functionItem(0)),
        life("completed"),
      ),
      bridge,
    ),
  )
  expect(JSON.stringify(received)).not.toContain("hidden prompt")
  expect(
    received.some(
      (e) =>
        e.type === "response.function_call_arguments.delta"
        && e.output_index === 1,
    ),
  ).toBe(true)
  expect(bridge.run.mock.calls[0][0]).toBe("hidden prompt")
})

test.each(["request", "reader"])(
  "%s cancellation aborts active generation",
  async (origin) => {
    const duringImage = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const bridge = makeBridge(async (_args, id, signal) => {
      duringImage.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted.resolve()
            resolve()
          },
          { once: true },
        ),
      )
      return result(id)
    })
    const controller = new AbortController()
    const response = wrap(
      source(life("completed", [functionItem(0, "paint")])),
      bridge,
      controller.signal,
    )
    const reader = response.body!.getReader()
    const drain = (async () => {
      while (!(await reader.read()).done) {
        /* drain */
      }
    })()
    await duringImage.promise
    if (origin === "request") controller.abort()
    else await reader.cancel()
    await aborted.promise
    await drain
    expect(bridge.run).toHaveBeenCalledTimes(1)
  },
)

test("leaves non-SSE and HTTP errors untouched", () => {
  const failure = new Response("error", { status: 400, headers })
  const json = Response.json({ ok: true })
  expect(wrap(failure)).toBe(failure)
  expect(wrap(json)).toBe(json)
})

test("disconnecting during argument streaming cancels an idle upstream body", async () => {
  const cancelled = Promise.withResolvers<void>()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          encode(itemFrame("added", 0, functionItem(0))),
        ),
      )
    },
    cancel() {
      cancelled.resolve()
    },
  })
  const bridge = makeBridge()
  const reader = wrap(new Response(body, { headers }), bridge).body!.getReader()
  await reader.read()
  await reader.cancel()
  await cancelled.promise
  expect(bridge.run).not.toHaveBeenCalled()
})
