import type { AnthropicThinkingBlock } from "~/lib/types/anthropic"
import type { GooglePart } from "~/lib/types/google"

// The prefix ends on a base64 group boundary.
const PREFIX = "copilot-api:agy:1:"
const BASE64_PREFIX = Buffer.from(PREFIX).toString("base64")

export type PositionedSignature = [
  signature: string,
  textLength: number,
  thoughtLength: number,
  fallbackThought?: string,
]

// Antigravity drops signatures on empty text parts before a tool call with
// no visible text. Send the whole span's records on a single part.
export function encodeAntigravitySignatures(
  signatures: ReadonlyArray<PositionedSignature>,
): string {
  const records = signatures
    .map((frame) => `${PREFIX}${JSON.stringify(frame)}\n`)
    .join("")
  return Buffer.from(records).toString("base64")
}

export function flushAntigravitySignatures(
  signatures: Array<PositionedSignature>,
  pendingSignatures: Array<string>,
  fallbackThought?: string,
): void {
  if (signatures.length === 0) return
  if (fallbackThought) signatures[0][3] = fallbackThought
  pendingSignatures.push(encodeAntigravitySignatures(signatures))
  signatures.length = 0
}

// Responses carries its reasoning ID after the last @. Compaction uses the
// same separator and also needs to survive Antigravity's concatenation.
export function isResponsesThinkingSignature(signature: string): boolean {
  const separator = signature.lastIndexOf("@")
  return separator >= 0 && separator < signature.length - 1
}

function readSignatures(value: string): Array<PositionedSignature> | undefined {
  if (!value.startsWith(BASE64_PREFIX)) return undefined
  try {
    const bytes = Buffer.from(value, "base64")
    if (bytes.toString("base64") !== value) return undefined
    const records = bytes.toString("utf8").split("\n")
    if (records.pop() !== "") return undefined
    const signatures: Array<PositionedSignature> = []
    for (const record of records) {
      if (!record.startsWith(PREFIX)) return undefined
      const frame: unknown = JSON.parse(record.slice(PREFIX.length))
      if (!Array.isArray(frame) || (frame.length !== 3 && frame.length !== 4)) {
        return undefined
      }
      const values: Array<unknown> = frame
      const [signature, textLength, thoughtLength, fallbackThought] = values
      if (
        typeof signature !== "string"
        || !isResponsesThinkingSignature(signature)
        || typeof textLength !== "number"
        || !Number.isSafeInteger(textLength)
        || textLength < 0
        || typeof thoughtLength !== "number"
        || !Number.isSafeInteger(thoughtLength)
        || thoughtLength < 0
        || (fallbackThought !== undefined
          && typeof fallbackThought !== "string")
      ) {
        return undefined
      }
      signatures.push([signature, textLength, thoughtLength, fallbackThought])
    }
    return signatures
  } catch {
    return undefined
  }
}

type ReplayPart = GooglePart | AnthropicThinkingBlock

export function hasAntigravitySignature(parts: Array<GooglePart>): boolean {
  return parts.some((part) => part.thoughtSignature?.startsWith(BASE64_PREFIX))
}

function unwrapFallbackSpan(parts: Array<GooglePart>): Array<ReplayPart> {
  const result: Array<ReplayPart> = []
  for (const part of parts) {
    const records =
      part.thoughtSignature ? readSignatures(part.thoughtSignature) : undefined
    if (!records) {
      result.push(part)
      continue
    }
    const { thoughtSignature: _dropped, ...rest } = part
    if (part.thought === true && typeof part.text === "string") {
      for (const [index, [signature]] of records.entries()) {
        result.push({
          type: "thinking",
          thinking: index === 0 ? part.text : "",
          signature,
        })
      }
      continue
    }
    for (const [signature] of records) {
      result.push({ type: "thinking", thinking: "", signature })
    }
    if (Object.keys(rest).length > 0) {
      result.push(rest)
    }
  }
  return result
}

function restoreSpan(parts: Array<GooglePart>): Array<ReplayPart> {
  if (!hasAntigravitySignature(parts)) {
    return parts
  }

  let text = ""
  let thought = ""
  const signatures: Array<PositionedSignature> = []
  for (const part of parts) {
    if (part.inlineData || part.fileData || part.functionResponse) {
      return unwrapFallbackSpan(parts)
    }
    if (part.thoughtSignature) {
      const records = readSignatures(part.thoughtSignature)
      if (!records) return unwrapFallbackSpan(parts)
      for (const record of records) signatures.push(record)
    }
    if (typeof part.text !== "string") continue
    if (part.thought) thought += part.text
    else text += part.text
  }
  // Antigravity can omit the thought part when replaying a tool call.
  thought ||= signatures[0]?.[3] ?? ""
  const restored: Array<ReplayPart> = []
  let textStart = 0
  let thoughtStart = 0
  for (const [signature, textLength, thoughtLength] of signatures) {
    if (textLength < textStart || thoughtLength < thoughtStart) {
      return unwrapFallbackSpan(parts)
    }
    const precedingText = text.slice(textStart, textLength)
    if (precedingText) restored.push({ text: precedingText })
    restored.push({
      type: "thinking",
      thinking: thought.slice(thoughtStart, thoughtLength),
      signature,
    })
    textStart = textLength
    thoughtStart = thoughtLength
  }
  if (thoughtStart < thought.length) {
    restored.push({ thought: true, text: thought.slice(thoughtStart) })
  }
  if (textStart < text.length) restored.push({ text: text.slice(textStart) })
  const functionCall = parts.at(-1)?.functionCall
  if (functionCall) restored.push({ functionCall })
  return restored
}

export function restoreAntigravityReasoningParts(
  parts: Array<GooglePart>,
): Array<ReplayPart> {
  if (!hasAntigravitySignature(parts)) {
    return parts
  }

  const restored: Array<ReplayPart> = []
  let start = 0
  for (const [index, part] of parts.entries()) {
    if (!part.functionCall && index < parts.length - 1) continue
    for (const item of restoreSpan(parts.slice(start, index + 1))) {
      restored.push(item)
    }
    start = index + 1
  }
  return restored
}
