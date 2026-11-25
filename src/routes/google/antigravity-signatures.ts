import type { AnthropicThinkingBlock } from "~/lib/types/anthropic"
import type {
  GoogleGenerateContentRequest,
  GooglePart,
} from "~/lib/types/google"

// Both prefixes end on a base64 3-byte boundary (18 bytes).
const PREFIX = "copilot-api:agy:1:"
const CALL_PREFIX = "copilot-api:agy:c:"
const BASE64_PREFIX = Buffer.from(PREFIX).toString("base64")
const CALL_BASE64_PREFIX = Buffer.from(CALL_PREFIX).toString("base64")

export type PositionedSignature = [
  signature: string,
  textLength: number,
  thoughtLength: number,
  fallbackThought?: string,
]

interface AntigravityEnvelope {
  signatures: Array<PositionedSignature>
  callId?: string
  innerSignature?: string
}

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

// Antigravity's gateway genai serializer omits functionCall.id and
// functionResponse.id on replay, but preserves per-part thoughtSignature.
export function encodeAntigravityToolCallSignature(
  callId: string,
  thoughtSignature?: string,
): string | undefined {
  const normalizedId = callId.trim()
  if (!normalizedId) return thoughtSignature
  if (thoughtSignature) {
    const envelope = readAntigravityEnvelope(thoughtSignature)
    if (
      envelope
      && envelope.signatures.length > 0
      && envelope.callId === undefined
      && envelope.innerSignature === undefined
    ) {
      const existing = Buffer.from(thoughtSignature, "base64").toString("utf8")
      const callRecord = `${CALL_PREFIX}${JSON.stringify([normalizedId])}\n`
      return Buffer.from(`${existing}${callRecord}`, "utf8").toString("base64")
    }
  }
  const payload =
    thoughtSignature ? [normalizedId, thoughtSignature] : [normalizedId]
  return Buffer.from(
    `${CALL_PREFIX}${JSON.stringify(payload)}\n`,
    "utf8",
  ).toString("base64")
}

// Responses carries its reasoning ID after the last @. Compaction uses the
// same separator and also needs to survive Antigravity's concatenation.
export function isResponsesThinkingSignature(signature: string): boolean {
  const separator = signature.lastIndexOf("@")
  return separator >= 0 && separator < signature.length - 1
}

function isEnvelopePrefix(value: string | undefined): value is string {
  return (
    typeof value === "string"
    && (value.startsWith(BASE64_PREFIX) || value.startsWith(CALL_BASE64_PREFIX))
  )
}

function parsePositionedSignatureRecord(
  record: string,
): PositionedSignature | undefined {
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
    || (fallbackThought !== undefined && typeof fallbackThought !== "string")
  ) {
    return undefined
  }
  return [signature, textLength, thoughtLength, fallbackThought]
}

function parseCallRecord(
  record: string,
): { callId: string; innerSignature?: string } | undefined {
  const frame: unknown = JSON.parse(record.slice(CALL_PREFIX.length))
  if (!Array.isArray(frame) || (frame.length !== 1 && frame.length !== 2)) {
    return undefined
  }
  const values: Array<unknown> = frame
  const [callId, innerSignature] = values
  if (typeof callId !== "string" || !callId.trim()) {
    return undefined
  }
  if (
    innerSignature !== undefined
    && (typeof innerSignature !== "string" || innerSignature.length === 0)
  ) {
    return undefined
  }
  return { callId: callId.trim(), innerSignature }
}

function readAntigravityEnvelope(
  value: string,
): AntigravityEnvelope | undefined {
  if (!isEnvelopePrefix(value)) return undefined
  try {
    const bytes = Buffer.from(value, "base64")
    if (bytes.toString("base64") !== value) return undefined
    const records = bytes.toString("utf8").split("\n")
    if (records.pop() !== "" || records.length === 0) return undefined
    const signatures: Array<PositionedSignature> = []
    let callId: string | undefined
    let innerSignature: string | undefined
    for (const record of records) {
      if (record.startsWith(PREFIX)) {
        const parsed = parsePositionedSignatureRecord(record)
        if (!parsed) return undefined
        signatures.push(parsed)
      } else if (record.startsWith(CALL_PREFIX)) {
        if (callId !== undefined) return undefined
        const parsed = parseCallRecord(record)
        if (!parsed) return undefined
        callId = parsed.callId
        innerSignature = parsed.innerSignature
      } else {
        return undefined
      }
    }
    return { signatures, callId, innerSignature }
  } catch {
    return undefined
  }
}

type ReplayPart = GooglePart | AnthropicThinkingBlock

export function hasAntigravitySignature(parts: Array<GooglePart>): boolean {
  return parts.some((part) => part.thoughtSignature?.startsWith(BASE64_PREFIX))
}

function hasAntigravityEnvelope(parts: Array<GooglePart>): boolean {
  return parts.some((part) => isEnvelopePrefix(part.thoughtSignature))
}

function withRestoredFunctionCallId(
  part: GooglePart,
  callId: string | undefined,
): GooglePart {
  if (!part.functionCall || !callId) return part
  const resolvedId = part.functionCall.id?.trim() || callId
  return {
    ...part,
    functionCall: {
      ...part.functionCall,
      id: resolvedId,
    },
  }
}

function unwrapFallbackSpan(parts: Array<GooglePart>): Array<ReplayPart> {
  const result: Array<ReplayPart> = []
  for (const part of parts) {
    const envelope =
      part.thoughtSignature ?
        readAntigravityEnvelope(part.thoughtSignature)
      : undefined
    if (!envelope) {
      result.push(part)
      continue
    }
    const { thoughtSignature: _dropped, ...rest } = part
    if (
      part.thought === true
      && typeof part.text === "string"
      && envelope.signatures.length > 0
    ) {
      for (const [index, [signature]] of envelope.signatures.entries()) {
        result.push({
          type: "thinking",
          thinking: index === 0 ? part.text : "",
          signature,
        })
      }
      continue
    }
    for (const [signature] of envelope.signatures) {
      result.push({ type: "thinking", thinking: "", signature })
    }
    const restoredPart = withRestoredFunctionCallId(
      envelope.innerSignature ?
        { ...rest, thoughtSignature: envelope.innerSignature }
      : rest,
      envelope.callId,
    )
    if (Object.keys(restoredPart).length > 0) {
      result.push(restoredPart)
    }
  }
  return result
}

function restoreSpan(parts: Array<GooglePart>): Array<ReplayPart> {
  if (!hasAntigravityEnvelope(parts)) {
    return parts
  }
  if (!hasAntigravitySignature(parts)) {
    return unwrapFallbackSpan(parts)
  }

  let text = ""
  let thought = ""
  const signatures: Array<PositionedSignature> = []
  let restoredCallId: string | undefined
  for (const [index, part] of parts.entries()) {
    if (part.inlineData || part.fileData || part.functionResponse) {
      return unwrapFallbackSpan(parts)
    }
    if (part.thoughtSignature) {
      const envelope = readAntigravityEnvelope(part.thoughtSignature)
      if (!envelope || envelope.innerSignature !== undefined) {
        return unwrapFallbackSpan(parts)
      }
      for (const record of envelope.signatures) signatures.push(record)
      if (index === parts.length - 1 && envelope.callId) {
        restoredCallId = envelope.callId
      }
    }
    if (typeof part.text !== "string") continue
    if (part.thought) thought += part.text
    else text += part.text
  }
  if (signatures.length === 0) {
    return unwrapFallbackSpan(parts)
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
  if (functionCall) {
    const callId = functionCall.id?.trim() || restoredCallId
    restored.push({
      functionCall: callId ? { ...functionCall, id: callId } : functionCall,
    })
  }
  return restored
}

export function restoreAntigravityReasoningParts(
  parts: Array<GooglePart>,
): Array<ReplayPart> {
  if (!hasAntigravityEnvelope(parts)) {
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

export function stripAntigravitySignatures(
  payload: GoogleGenerateContentRequest,
): GoogleGenerateContentRequest {
  if (!Array.isArray(payload.contents)) return payload
  const hasGatewayEnvelope = payload.contents.some(
    (content) =>
      Array.isArray(content?.parts)
      && content.parts.some(
        (part) =>
          typeof part?.thoughtSignature === "string"
          && readAntigravityEnvelope(part.thoughtSignature) !== undefined,
      ),
  )
  if (!hasGatewayEnvelope) return payload

  return {
    ...payload,
    contents: payload.contents.map((content) => {
      if (!Array.isArray(content?.parts)) return content
      const parts = content.parts.flatMap((part) => {
        if (
          typeof part?.thoughtSignature !== "string"
          || readAntigravityEnvelope(part.thoughtSignature) === undefined
        ) {
          return [part]
        }
        const { thoughtSignature: _dropped, ...rest } = part
        const keys = Object.keys(rest)
        if (
          keys.length === 0
          || (keys.length === 1 && keys[0] === "text" && rest.text === "")
        ) {
          return []
        }
        return [rest]
      })
      return { ...content, parts }
    }),
  }
}
