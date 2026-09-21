import { createHash } from "node:crypto"

import { createHandlerLogger } from "./logger"

import type { AnthropicStreamEventData } from "./types/anthropic"

// Debug-gated raw-SSE integrity capture for the Anthropic-compatible Messages
// flow. The flow forwards upstream SSE verbatim, so this capture determines
// whether malformed tool input arrived at the gateway boundary or diverged
// locally. It is inert unless COPILOT_API_CAPTURE_TOOLUSE_SSE is enabled.

const CAPTURE_ENV = "COPILOT_API_CAPTURE_TOOLUSE_SSE"
const DISABLED_VALUES = new Set(["", "0", "false", "off", "no"])

export const isToolUseSseCaptureEnabled = (): boolean => {
  const raw = process.env[CAPTURE_ENV]?.trim().toLowerCase()
  return raw !== undefined && !DISABLED_VALUES.has(raw)
}

interface ToolUseBlockCapture {
  index: number
  fragments: Array<string>
  malformed: boolean
}

export interface ToolUseSseCaptureSummary {
  verdict: "upstream-boundary-malformed" | "local-divergence" | "boundary-clean"
  frames: number
  toolUseBlocks: number
  malformedBlocks: number
  localDivergence: boolean
}

export interface ToolUseSseCapture {
  record: (
    eventName: string | undefined,
    receivedData: string,
    forwardedData: string,
  ) => void
  finish: () => ToolUseSseCaptureSummary
}

const logger = createHandlerLogger("tooluse-sse-capture")

const parseEvent = (data: string): AnthropicStreamEventData | undefined => {
  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return undefined
  }
}

const assembleIsValid = (assembled: string): boolean => {
  if (assembled.length === 0) return true
  try {
    JSON.parse(assembled)
    return true
  } catch {
    return false
  }
}

const describePayload = (payload: string) => ({
  bytes: Buffer.byteLength(payload),
  sha256: createHash("sha256").update(payload).digest("hex"),
})

class ActiveToolUseSseCapture implements ToolUseSseCapture {
  private readonly blocks = new Map<number, ToolUseBlockCapture>()
  private frameCount = 0
  private localDivergence = false

  record(
    eventName: string | undefined,
    receivedData: string,
    forwardedData: string,
  ): void {
    try {
      this.frameCount += 1

      if (receivedData !== forwardedData) {
        this.localDivergence = true
        logger.warn(
          "LOCAL DIVERGENCE: forwarded bytes differ from received bytes",
          JSON.stringify({
            eventName,
            forwarded: describePayload(forwardedData),
            received: describePayload(receivedData),
          }),
        )
      }

      const event = parseEvent(receivedData)
      if (!event) return
      this.inspect(event, receivedData)
    } catch {
      // Capture must never disrupt the stream it observes.
    }
  }

  private inspect(event: AnthropicStreamEventData, receivedData: string): void {
    if (
      event.type === "content_block_start"
      && event.content_block.type === "tool_use"
    ) {
      this.blocks.set(event.index, {
        index: event.index,
        fragments: [],
        malformed: false,
      })
      this.logFrame(event.type, receivedData)
      return
    }

    if (
      event.type === "content_block_delta"
      && event.delta.type === "input_json_delta"
    ) {
      const block = this.blocks.get(event.index)
      if (!block) return
      block.fragments.push(event.delta.partial_json)
      this.logFrame(event.type, receivedData)
      return
    }

    if (event.type === "content_block_stop") {
      const block = this.blocks.get(event.index)
      if (!block) return
      const assembled = block.fragments.join("")
      block.malformed = !assembleIsValid(assembled)
      this.logFrame(event.type, receivedData)
      if (block.malformed) {
        logger.warn(
          "UPSTREAM MALFORMED: tool_use input is not valid JSON at the copilot-api boundary",
          JSON.stringify({
            index: block.index,
            fragments: block.fragments.length,
            input: describePayload(assembled),
          }),
        )
      }
    }
  }

  private logFrame(eventName: string, data: string): void {
    logger.info(
      "tool_use frame",
      JSON.stringify({ eventName, ...describePayload(data) }),
    )
  }

  finish(): ToolUseSseCaptureSummary {
    const blocks = [...this.blocks.values()]
    const malformed = blocks.filter((block) => block.malformed).length
    const verdict: ToolUseSseCaptureSummary["verdict"] =
      malformed > 0 ? "upstream-boundary-malformed"
      : this.localDivergence ? "local-divergence"
      : "boundary-clean"
    const summary: ToolUseSseCaptureSummary = {
      verdict,
      frames: this.frameCount,
      toolUseBlocks: blocks.length,
      malformedBlocks: malformed,
      localDivergence: this.localDivergence,
    }
    try {
      logger.info("capture summary", JSON.stringify(summary))
    } catch {
      // Never disrupt teardown.
    }
    return summary
  }
}

export const createToolUseSseCapture = (): ToolUseSseCapture | undefined =>
  isToolUseSseCaptureEnabled() ? new ActiveToolUseSseCapture() : undefined
