import { createHash } from "node:crypto"

import { createHandlerLogger } from "./logger"

import type { AnthropicStreamEventData } from "./types/anthropic"

const CAPTURE_ENV = "COPILOT_API_CAPTURE_TOOLUSE_SSE"
const DISABLED_VALUES = new Set(["", "0", "false", "off", "no"])
const MAX_ACTIVE_TOOL_USE_BLOCKS = 64
export const TOOL_USE_SSE_CAPTURE_BYTE_LIMIT = 1024 * 1024

export const isToolUseSseCaptureEnabled = (): boolean => {
  const raw = process.env[CAPTURE_ENV]?.trim().toLowerCase()
  return raw !== undefined && !DISABLED_VALUES.has(raw)
}

interface ToolUseBlockCapture {
  index: number
  fragments: Array<string>
  fragmentCount: number
}

export interface ToolUseSseCaptureSummary {
  verdict:
    | "upstream-boundary-malformed"
    | "capture-limit-exceeded"
    | "boundary-clean"
  frames: number
  toolUseBlocks: number
  malformedBlocks: number
  truncatedBlocks: number
}

export interface ToolUseSseCapture {
  record: (receivedData: string) => void
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
  private capturedBytes = 0
  private captureLimitExceeded = false
  private frameCount = 0
  private malformedBlockCount = 0
  private toolUseBlockCount = 0
  private truncatedBlockCount = 0

  record(receivedData: string): void {
    try {
      this.frameCount += 1
      if (this.captureLimitExceeded) return

      const event = parseEvent(receivedData)
      if (!event) return
      this.inspect(event)
    } catch {
      // Capture must never disrupt the stream it observes.
    }
  }

  private exceedCaptureLimit(): void {
    this.captureLimitExceeded = true
    this.truncatedBlockCount += this.blocks.size
    this.blocks.clear()
  }

  private inspect(event: AnthropicStreamEventData): void {
    if (
      event.type === "content_block_start"
      && event.content_block.type === "tool_use"
    ) {
      this.toolUseBlockCount += 1
      if (
        !this.blocks.has(event.index)
        && this.blocks.size >= MAX_ACTIVE_TOOL_USE_BLOCKS
      ) {
        this.exceedCaptureLimit()
        return
      }
      this.blocks.set(event.index, {
        index: event.index,
        fragments: [],
        fragmentCount: 0,
      })
      return
    }

    if (
      event.type === "content_block_delta"
      && event.delta.type === "input_json_delta"
    ) {
      const block = this.blocks.get(event.index)
      if (!block || event.delta.partial_json.length === 0) return
      const fragmentBytes = Buffer.byteLength(event.delta.partial_json)
      if (
        this.capturedBytes + fragmentBytes
        > TOOL_USE_SSE_CAPTURE_BYTE_LIMIT
      ) {
        this.exceedCaptureLimit()
        return
      }
      this.capturedBytes += fragmentBytes
      block.fragments.push(event.delta.partial_json)
      block.fragmentCount += 1
      return
    }

    if (event.type === "content_block_stop") {
      const block = this.blocks.get(event.index)
      if (!block) return
      this.blocks.delete(event.index)
      const assembled = block.fragments.join("")
      if (!assembleIsValid(assembled)) {
        this.malformedBlockCount += 1
        logger.warn(
          "UPSTREAM MALFORMED: tool_use input is not valid JSON at the copilot-api boundary",
          JSON.stringify({
            index: block.index,
            fragments: block.fragmentCount,
            input: describePayload(assembled),
          }),
        )
      }
      block.fragments.length = 0
    }
  }

  finish(): ToolUseSseCaptureSummary {
    if (this.blocks.size > 0) {
      this.truncatedBlockCount += this.blocks.size
      this.blocks.clear()
    }
    const verdict: ToolUseSseCaptureSummary["verdict"] =
      this.malformedBlockCount > 0 ? "upstream-boundary-malformed"
      : this.captureLimitExceeded ? "capture-limit-exceeded"
      : "boundary-clean"
    const summary: ToolUseSseCaptureSummary = {
      verdict,
      frames: this.frameCount,
      toolUseBlocks: this.toolUseBlockCount,
      malformedBlocks: this.malformedBlockCount,
      truncatedBlocks: this.truncatedBlockCount,
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
