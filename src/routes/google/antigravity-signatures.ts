import type { AnthropicThinkingBlock } from "~/lib/types/anthropic"
import type { GooglePart } from "~/lib/types/google"

// The prefix ends on a base64 group boundary.
const PREFIX = "copilot-api:agy:1:"
const BASE64_PREFIX = Buffer.from(PREFIX).toString("base64")

type PositionedSignature = [
  signature: string,
  textLength: number,
  thoughtLength: number,
]

// Antigravity concatenates text-part signature bytes between tool calls.
// A newline separates the records, and offsets partition the merged text.
export function encodeAntigravitySignature(
  signature: string,
  textLength: number,
  thoughtLength: number,
): string {
  const frame: PositionedSignature = [signature, textLength, thoughtLength]
  return Buffer.from(`${PREFIX}${JSON.stringify(frame)}\n`).toString("base64")
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
      if (!Array.isArray(frame) || frame.length !== 3) return undefined
      const values: Array<unknown> = frame
      const [signature, textLength, thoughtLength] = values
      if (
        typeof signature !== "string"
        || !isResponsesThinkingSignature(signature)
        || typeof textLength !== "number"
        || !Number.isSafeInteger(textLength)
        || textLength < 0
        || typeof thoughtLength !== "number"
        || !Number.isSafeInteger(thoughtLength)
        || thoughtLength < 0
      ) {
        return undefined
      }
      signatures.push([signature, textLength, thoughtLength])
    }
    return signatures
  } catch {
    return undefined
  }
}

type ReplayPart = GooglePart | AnthropicThinkingBlock

function restoreSpan(parts: Array<GooglePart>): Array<ReplayPart> {
  if (!parts.some((part) => part.thoughtSignature?.startsWith(BASE64_PREFIX))) {
    return parts
  }

  let text = ""
  let thought = ""
  const signatures: Array<PositionedSignature> = []
  for (const part of parts) {
    if (part.inlineData || part.fileData || part.functionResponse) return parts
    if (part.thoughtSignature) {
      const records = readSignatures(part.thoughtSignature)
      if (!records) return parts
      for (const record of records) signatures.push(record)
    }
    if (typeof part.text !== "string") continue
    if (part.thought) thought += part.text
    else text += part.text
  }
  const restored: Array<ReplayPart> = []
  let textStart = 0
  let thoughtStart = 0
  for (const [signature, textLength, thoughtLength] of signatures) {
    if (textLength < textStart || thoughtLength < thoughtStart) return parts
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
  if (!parts.some((part) => part.thoughtSignature?.startsWith(BASE64_PREFIX))) {
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
