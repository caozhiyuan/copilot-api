import { randomUUID } from "node:crypto"

import type { AnthropicStreamEventData } from "~/lib/types/anthropic"
import type {
  GoogleGenerateContentResponse,
  GooglePart,
  GoogleUsageMetadata,
} from "~/lib/types/google"

import {
  encodeGoogleSignature,
  getGoogleStopReason,
  translateGoogleUsage,
} from "./google-translation"

export class GoogleMessagesStreamTranslator {
  private started = false
  private nextIndex = 0
  private block?: { index: number; type: "text" | "thinking"; signed: boolean }
  private hasTools = false
  private finishReason?: string
  private blocked?: string
  private usageMetadata: GoogleUsageMetadata = {}

  private readonly model: string

  constructor(model: string) {
    this.model = model
  }

  get usage() {
    return translateGoogleUsage(this.usageMetadata)
  }

  push(
    response: GoogleGenerateContentResponse,
  ): Array<AnthropicStreamEventData> {
    if (response.error)
      throw new Error(response.error.message ?? "Google stream failed")
    this.usageMetadata = { ...this.usageMetadata, ...response.usageMetadata }
    const events: Array<AnthropicStreamEventData> = []
    if (!this.started) {
      this.started = true
      events.push({
        type: "message_start",
        message: {
          id: response.responseId || `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...this.usage, output_tokens: 0 },
        },
      })
    }
    const candidate = response.candidates?.[0]
    for (const part of candidate?.content?.parts ?? [])
      this.addPart(part, events)
    this.finishReason = candidate?.finishReason ?? this.finishReason
    this.blocked = response.promptFeedback?.blockReason ?? this.blocked
    return events
  }

  finish(): Array<AnthropicStreamEventData> {
    const stopReason = getGoogleStopReason(
      this.finishReason,
      this.hasTools,
      this.blocked,
    )
    const events: Array<AnthropicStreamEventData> = []
    this.closeBlock(events)
    events.push(
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: this.usage,
      },
      { type: "message_stop" },
    )
    return events
  }

  private addPart(
    part: GooglePart,
    events: Array<AnthropicStreamEventData>,
  ): void {
    if (part.functionCall) {
      this.closeBlock(events)
      const index = this.nextIndex++
      const call = part.functionCall
      this.hasTools = true
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: call.id || `toolu_${randomUUID()}`,
            name: call.name,
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(call.args ?? {}),
          },
        },
        { type: "content_block_stop", index },
      )
      if (part.thoughtSignature)
        this.addSignature(part.thoughtSignature, events)
      return
    }
    if (part.text || part.thought) {
      const type = part.thought ? "thinking" : "text"
      if (this.block?.type !== type) this.closeBlock(events)
      if (!this.block) {
        const index = this.nextIndex++
        this.block = { index, type, signed: false }
        events.push({
          type: "content_block_start",
          index,
          content_block:
            type === "thinking" ? { type, thinking: "" } : { type, text: "" },
        })
      }
      events.push({
        type: "content_block_delta",
        index: this.block.index,
        delta:
          type === "thinking" ?
            { type: "thinking_delta", thinking: part.text ?? "" }
          : { type: "text_delta", text: part.text ?? "" },
      })
    }
    if (part.thoughtSignature) this.addSignature(part.thoughtSignature, events)
  }

  private addSignature(
    signature: string,
    events: Array<AnthropicStreamEventData>,
  ): void {
    if (this.block?.type === "thinking") {
      this.block.signed = true
      events.push({
        type: "content_block_delta",
        index: this.block.index,
        delta: {
          type: "signature_delta",
          signature: encodeGoogleSignature(signature, "thinking"),
        },
      })
      this.closeBlock(events)
      return
    }
    this.closeBlock(events)
    const index = this.nextIndex++
    events.push(
      {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index,
        delta: {
          type: "signature_delta",
          signature: encodeGoogleSignature(signature, "previous"),
        },
      },
      { type: "content_block_stop", index },
    )
  }

  private closeBlock(events: Array<AnthropicStreamEventData>): void {
    if (!this.block) return
    if (this.block.type === "thinking" && !this.block.signed) {
      events.push({
        type: "content_block_delta",
        index: this.block.index,
        delta: { type: "signature_delta", signature: "" },
      })
    }
    events.push({ type: "content_block_stop", index: this.block.index })
    this.block = undefined
  }
}
