// Run with: bun run bench:responses-ws [events-per-run]
// Microbenchmark of the production decoders + pool terminal classification.
// Synthetic normal events only (errors are covered by regression tests).
import { createCodexResponsesWebSocketStreamChunk } from "~/services/codex/create-responses"
import { createResponsesWebSocketStreamChunk } from "~/services/copilot/create-responses"
import { getResponsesStreamTerminalDisposition } from "~/services/responses-websocket-helpers"

interface Chunk {
  data?: string
  event?: string
  id?: string
}

type Decoder = (data: string) => Chunk
type Disposition = (chunk: Chunk) => string

const iterations = Number(process.argv[2] ?? 100_000)
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new Error("events-per-run must be a positive integer")
}

const payloads = Array.from({ length: 32 }, (_, index) => {
  const complete = index % 16 === 0
  return JSON.stringify({
    id: `event-${index}`,
    sequence_number: index,
    type: complete ? "response.completed" : "response.output_text.delta",
    ...(complete ?
      { response: { usage: { input_tokens: 2048, output_tokens: 256 } } }
    : { delta: "streamed text ".repeat(32) }),
  })
})

// Previous implementation: JSON.parse + JSON.stringify for every event,
// followed by another JSON.parse in terminal disposition.
const legacyDecoder: Decoder = (data) => {
  const parsed = JSON.parse(data) as { id?: unknown; type?: unknown }
  return {
    data: JSON.stringify(parsed),
    event: typeof parsed.type === "string" ? parsed.type : undefined,
    id: typeof parsed.id === "string" ? parsed.id : undefined,
  }
}

const legacyDisposition: Disposition = (chunk) => {
  if (!chunk.data || chunk.data === "[DONE]") return "continue"
  const parsed = JSON.parse(chunk.data) as { type?: unknown }
  if (parsed.type === "error" || parsed.type === "response.failed") {
    return "discard"
  }
  if (
    parsed.type === "response.completed"
    || parsed.type === "response.incomplete"
  ) {
    return "reuse"
  }
  return "continue"
}

function runEvents(
  decode: Decoder,
  disposition: Disposition,
  count: number,
): number {
  let checksum = 0
  for (let i = 0; i < count; i++) {
    const chunk = decode(payloads[i % payloads.length])
    checksum += chunk.data?.length ?? 0
    if (disposition(chunk) === "reuse") checksum++
  }
  return checksum
}

function medianElapsedMs(
  decode: Decoder,
  disposition: Disposition,
): number {
  runEvents(decode, disposition, Math.min(iterations, 10_000))
  const timings: Array<number> = []
  let checksum = 0
  for (let repeat = 0; repeat < 5; repeat++) {
    const start = performance.now()
    checksum += runEvents(decode, disposition, iterations)
    timings.push(performance.now() - start)
  }
  if (checksum <= 0) throw new Error("Unexpected empty benchmark result")
  timings.sort((a, b) => a - b)
  return timings[2]
}

const formatRate = (milliseconds: number): string =>
  Math.round((iterations * 1_000) / milliseconds).toLocaleString("en-US")

console.log(`Responses WebSocket event microbenchmark (${iterations} events/run, median of 5)`)
console.log("Synthetic payloads; excludes network, model latency, and SSE writes.\n")

for (const [name, optimizedDecoder] of [
  ["Codex", createCodexResponsesWebSocketStreamChunk],
  ["Copilot", createResponsesWebSocketStreamChunk],
] as const) {
  const previous = medianElapsedMs(legacyDecoder, legacyDisposition)
  const optimized = medianElapsedMs(
    optimizedDecoder,
    getResponsesStreamTerminalDisposition,
  )
  console.log(
    `${name}: previous ${formatRate(previous)} events/s, `
      + `optimized ${formatRate(optimized)} events/s `
      + `(${(previous / optimized).toFixed(2)}x)`,
  )
}
