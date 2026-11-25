import { events, type ServerSentEventMessage } from "fetch-event-stream"
import { SSEStreamingApi } from "hono/streaming"

import { writeSSEIfConnected } from "~/lib/http/sse"
import type { ImageGenerationCall } from "~/lib/types/responses"

import { newImageCallId, type ImageToolBridge } from "./image-tool"
import { isRecord } from "./messages-translation/parse"

type WireObject = Record<string, unknown>
type WireEvent = WireObject & { type: string }
interface PendingCall {
  id: string
  arguments: string
  ready: boolean
  announced: boolean
  result?: ImageGenerationCall
}

const ADDED = "response.output_item.added"
const DONE = "response.output_item.done"
const ARG_DELTA = "response.function_call_arguments.delta"
const ARG_DONE = "response.function_call_arguments.done"
const IMAGE = "response.image_generation_call."

const imageItem = (
  call: PendingCall,
  status: ImageGenerationCall["status"] = "in_progress",
): ImageGenerationCall =>
  call.result ?? {
    id: call.id,
    type: "image_generation_call",
    status,
    result: "",
  }

const terminal = (type: string) =>
  type === "response.completed"
  || type === "response.failed"
  || type === "response.incomplete"

function outputIndex(event: WireEvent): number {
  const index = event.output_index
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) {
    throw new Error("Missing output index")
  }
  return index
}

class ImageToolStream {
  private readonly calls = new Map<number, PendingCall>()
  private readonly callIndexes = new Map<string, number>()
  private readonly otherItems = new Map<number, WireObject>()
  // A delta alone has no tool name. Hold it until the corresponding item identifies the tool.
  private readonly unidentified = new Map<number, Array<WireEvent>>()
  private readonly bridge: ImageToolBridge
  private readonly stream: SSEStreamingApi
  private readonly signal: AbortSignal
  private response: WireObject = {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
  }
  private sequence = 0
  private upstreamError = false

  constructor(
    bridge: ImageToolBridge,
    stream: SSEStreamingApi,
    signal: AbortSignal,
  ) {
    this.bridge = bridge
    this.stream = stream
    this.signal = signal
  }

  async forward(source: Response): Promise<void> {
    let finished = false
    try {
      for await (const frame of events(source, this.signal)) {
        this.signal.throwIfAborted()
        if (frame.data === "[DONE]") {
          if (finished) await this.stream.writeSSE({ data: frame.data })
          break
        }
        if (!frame.data || finished) continue
        const event: unknown = JSON.parse(frame.data)
        if (!isRecord(event) || typeof event.type !== "string")
          throw new Error("Invalid Responses event")
        const typed = event as WireEvent
        const isTerminal = await this.handle(typed, frame)
        if (isTerminal) {
          finished = true
          if (typed.type !== "response.completed") break
        }
      }
      if (!finished && !this.signal.aborted)
        await this.fail(
          "The upstream Responses stream ended before completion.",
        )
    } catch {
      if (!this.signal.aborted && !finished)
        await this.fail("The image generation request could not be completed.")
    }
  }

  private send(event: WireEvent, frame?: ServerSentEventMessage) {
    this.signal.throwIfAborted()
    if (event.type.startsWith("response.") || event.type === "error")
      event.sequence_number = this.sequence++
    return writeSSEIfConnected(
      this.stream,
      {
        event: frame?.event ?? event.type,
        id: frame?.id?.toString(),
        retry: frame?.retry,
        data: JSON.stringify(event),
      },
      event.type,
    )
  }

  private getCall(index: number, item?: WireObject): PendingCall {
    const key = item?.call_id ?? item?.id
    if (typeof key === "string" && key) {
      const prior = this.callIndexes.get(key)
      if (prior !== undefined && prior !== index)
        throw new Error("Duplicate image tool call")
      this.callIndexes.set(key, index)
    }
    let call = this.calls.get(index)
    if (!call) {
      if (this.otherItems.has(index))
        throw new Error("Conflicting output index")
      call = {
        id: newImageCallId(),
        arguments: "",
        announced: false,
        ready: false,
      }
      this.calls.set(index, call)
      for (const event of this.unidentified.get(index) ?? [])
        this.updateArguments(call, event)
      this.unidentified.delete(index)
    }
    return call
  }

  private updateArguments(call: PendingCall, event: WireEvent) {
    if (event.type === ARG_DONE) {
      if (typeof event.arguments === "string" && event.arguments)
        call.arguments = event.arguments
      call.ready = true
    } else if (!call.ready && typeof event.delta === "string") {
      call.arguments += event.delta
    }
  }

  private buffer(index: number, event: WireEvent) {
    const buffered = this.unidentified.get(index) ?? []
    buffered.push(event)
    this.unidentified.set(index, buffered)
  }

  private bufferedName(index: number) {
    return this.unidentified.get(index)?.find((event) => !!event.name)?.name
  }

  private observeItem(
    index: number,
    item: WireObject,
    done: boolean,
  ): PendingCall | undefined {
    const name =
      item.name
      || (this.calls.has(index) ? this.bridge.name : this.bufferedName(index))
    if (
      item.type !== "function_call"
      || item.namespace
      || name !== this.bridge.name
    ) {
      if (this.calls.has(index))
        throw new Error("Conflicting tool at output index")
      this.otherItems.set(index, item)
      return
    }
    const call = this.getCall(index, item)
    if (typeof item.arguments === "string" && item.arguments)
      call.arguments = item.arguments
    if (done) call.ready = !item.status || item.status === "completed"
    return call
  }

  private async announce(index: number, call: PendingCall) {
    if (call.announced) return
    call.announced = true
    await this.send({ type: ADDED, output_index: index, item: imageItem(call) })
    await this.send({
      type: `${IMAGE}in_progress`,
      output_index: index,
      item_id: call.id,
    })
  }

  private async flushOther(index: number) {
    for (const event of this.unidentified.get(index) ?? [])
      await this.send(event)
    this.unidentified.delete(index)
  }

  private async handle(event: WireEvent, frame: ServerSentEventMessage) {
    if (event.type === "error") this.upstreamError = true
    if (event.type === ADDED || event.type === DONE) {
      if (!isRecord(event.item)) throw new Error("Invalid output item")
      const index = outputIndex(event)
      if (
        event.item.type === "function_call"
        && !event.item.name
        && !event.item.namespace
        && !this.bufferedName(index)
        && !this.calls.has(index)
        && !this.otherItems.has(index)
      ) {
        this.buffer(index, event)
        return false
      }
      const call = this.observeItem(index, event.item, event.type === DONE)
      if (call) {
        await this.announce(index, call)
      } else {
        if (event.type === DONE) await this.flushOther(index)
        await this.send(event, frame)
        if (event.type === ADDED) await this.flushOther(index)
      }
      return false
    }
    if (event.type === ARG_DELTA || event.type === ARG_DONE) {
      const index = outputIndex(event)
      const call = this.calls.get(index)
      if (call) this.updateArguments(call, event)
      else if (
        this.otherItems.has(index)
        || event.namespace
        || (typeof event.name === "string"
          && event.name
          && event.name !== this.bridge.name)
      ) {
        await this.flushOther(index)
        await this.send(event, frame)
      } else {
        this.buffer(index, event)
      }
      return false
    }

    if (isRecord(event.response)) {
      this.response = event.response
      this.bridge.restoreTools(this.response)
      if (Array.isArray(this.response.output)) {
        this.response.output = this.response.output.map(
          (item: unknown, index: number) => {
            if (!isRecord(item)) return item
            const call = this.observeItem(
              index,
              item,
              event.type === "response.completed",
            )
            return call ? imageItem(call) : item
          },
        )
      }
    }
    if (terminal(event.type)) {
      if (!isRecord(event.response))
        throw new Error("Missing terminal response")
      for (const index of this.otherItems.keys()) await this.flushOther(index)
      if (this.calls.size) {
        if (event.type === "response.completed") {
          if (
            this.upstreamError
            || (this.response.status && this.response.status !== "completed")
            || !this.finalOutput().length
          )
            throw new Error("Incomplete upstream response")
          await this.generate()
        } else await this.closeFailedItems()
        this.response.output = this.finalOutput()
      }
      await this.send(event, frame)
      return true
    }
    await this.send(event, frame)
    return false
  }

  private async generate() {
    for (const [index, call] of this.calls) {
      if (!call.ready) throw new Error("Incomplete image tool call")
      await this.announce(index, call)
    }
    const siblings = new AbortController()
    const signal = AbortSignal.any([this.signal, siblings.signal])
    try {
      await Promise.all(
        [...this.calls].map(async ([index, call]) => {
          const fields = { output_index: index, item_id: call.id }
          await this.send({ type: `${IMAGE}generating`, ...fields })
          signal.throwIfAborted()
          const result = await this.bridge.run(
            call.arguments,
            call.id,
            signal,
            async (partialIndex, b64) => {
              signal.throwIfAborted()
              await this.send({
                type: `${IMAGE}partial_image`,
                ...fields,
                partial_image_index: partialIndex,
                partial_image_b64: b64,
              })
            },
          )
          signal.throwIfAborted()
          call.result = result
          // Queue both writes before a sibling failure can terminate the response.
          await Promise.all([
            this.send({ type: `${IMAGE}completed`, ...fields }),
            this.send({ type: DONE, output_index: index, item: result }),
          ])
        }),
      )
    } finally {
      siblings.abort()
    }
  }

  private async closeFailedItems() {
    for (const [index, call] of this.calls) {
      if (call.announced && !call.result)
        await this.send({
          type: DONE,
          output_index: index,
          item: imageItem(call, "failed"),
        })
    }
  }

  private finalOutput() {
    const output = new Map<number, unknown>(this.otherItems)
    for (const [index, call] of this.calls)
      output.set(index, imageItem(call, "failed"))
    // Missing slots cannot be compressed: Codex has already received the original output_index values.
    const items: Array<unknown> = []
    for (let i = 0; i < output.size; i++) {
      if (!output.has(i)) return []
      items.push(output.get(i))
    }
    return items
  }

  private async fail(message: string) {
    await this.closeFailedItems()
    await this.send({
      type: "response.failed",
      response: {
        ...this.response,
        output: this.finalOutput(),
        status: "failed",
        error: { code: "server_error", message },
      },
    })
  }
}

export function bridgeImageToolStream(
  response: Response,
  bridge: ImageToolBridge,
  signal: AbortSignal,
): Response {
  if (
    !response.ok
    || !response.body
    || !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return response
  const transport = new TransformStream<Uint8Array, Uint8Array>()
  const stream = new SSEStreamingApi(transport.writable, transport.readable)
  const stop = new AbortController()
  stream.onAbort(() => stop.abort())
  const cancel = () => stream.abort()
  if (signal.aborted) cancel()
  else signal.addEventListener("abort", cancel, { once: true })
  const source = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>(),
    { signal: stop.signal },
  )
  const flow = new ImageToolStream(bridge, stream, stop.signal)
  void flow
    .forward(new Response(source))
    .finally(() => {
      signal.removeEventListener("abort", cancel)
      stop.abort()
      return stream.close()
    })
    .catch(() => {})
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  return new Response(stream.responseReadable, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}
