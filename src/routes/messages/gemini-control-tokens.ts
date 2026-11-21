export const GEMINI_CONTROL_TOKENS = [
  "<start_of_image>",
  "<end_of_image>",
  "<start_of_audio>",
  "<end_of_audio>",
  "<start_of_turn>",
  "<end_of_turn>",
  "<eos>",
] as const

const GEMINI_MODEL_ID_PATTERN = /(?:^|[/._:-])(?:gemini|gemma)(?:$|[/._:\d-])/iu

const MAX_LEADING_WHITESPACE = 64
const MAX_TRAILING_HOLD_CHARS = 16_384

export interface GeminiTextSanitizerState {
  leading: boolean
  strippedLeading: boolean
  buffer: string
}

export function createGeminiTextSanitizerState(): GeminiTextSanitizerState {
  return {
    leading: true,
    strippedLeading: false,
    buffer: "",
  }
}

export function isGeminiControlTokenModel(
  model?: string | null,
  vendor?: string | null,
): boolean {
  if (vendor && vendor.trim().toLowerCase() === "google") {
    return true
  }
  if (!model) {
    return false
  }
  return GEMINI_MODEL_ID_PATTERN.test(model)
}

function isWhitespaceChar(ch: string): boolean {
  return (
    ch === " "
    || ch === "\n"
    || ch === "\r"
    || ch === "\t"
    || ch === "\f"
    || ch === "\v"
    || /\s/u.test(ch)
  )
}

function matchControlTokenAt(
  text: string,
  index: number,
): (typeof GEMINI_CONTROL_TOKENS)[number] | undefined {
  if (text[index] !== "<") {
    return undefined
  }
  for (const token of GEMINI_CONTROL_TOKENS) {
    if (text.startsWith(token, index)) {
      return token
    }
  }
  return undefined
}

function isIncompleteControlTokenPrefix(text: string, index = 0): boolean {
  if (index >= text.length || text[index] !== "<") {
    return false
  }
  const slice = index === 0 ? text : text.slice(index)
  return GEMINI_CONTROL_TOKENS.some(
    (token) => slice.length < token.length && token.startsWith(slice),
  )
}

function inspectTrailingCandidate(
  text: string,
  startIndex: number,
):
  | { kind: "complete" }
  | { kind: "incomplete" }
  | { kind: "none"; nextSearchIndex: number } {
  let cursor = startIndex
  while (cursor < text.length) {
    const token = matchControlTokenAt(text, cursor)
    if (!token) {
      if (isIncompleteControlTokenPrefix(text, cursor)) {
        return { kind: "incomplete" }
      }
      return {
        kind: "none",
        nextSearchIndex: Math.max(startIndex + 1, cursor + 1),
      }
    }
    cursor += token.length
    while (cursor < text.length && isWhitespaceChar(text[cursor])) {
      cursor++
    }
  }
  return { kind: "complete" }
}

function findTrailingHoldIndex(text: string, eof: boolean): number {
  let searchFrom = 0
  while (searchFrom < text.length) {
    const ltIndex = text.indexOf("<", searchFrom)
    if (ltIndex === -1) {
      return text.length
    }
    const candidate = inspectTrailingCandidate(text, ltIndex)
    if (candidate.kind === "complete") {
      return ltIndex
    }
    if (candidate.kind === "incomplete") {
      if (!eof) {
        return ltIndex
      }
      searchFrom = ltIndex + 1
      continue
    }
    searchFrom = candidate.nextSearchIndex
  }
  return text.length
}

function trimOverflowHoldBuffer(buffer: string): string {
  if (buffer.length <= MAX_TRAILING_HOLD_CHARS) {
    return buffer
  }
  let cursor = 0
  while (buffer.length - cursor > MAX_TRAILING_HOLD_CHARS) {
    const token = matchControlTokenAt(buffer, cursor)
    if (!token) {
      break
    }
    cursor += token.length
    while (cursor < buffer.length && isWhitespaceChar(buffer[cursor])) {
      cursor++
    }
  }
  return cursor > 0 ? buffer.slice(cursor) : buffer
}

export function pushGeminiTextChunk(
  state: GeminiTextSanitizerState,
  chunk: string,
): string {
  if (chunk.length === 0) {
    return ""
  }
  if (!state.leading && state.buffer.length === 0 && !chunk.includes("<")) {
    return chunk
  }

  let buf = state.buffer + chunk
  while (state.leading) {
    if (!state.strippedLeading) {
      let wsEnd = 0
      while (
        wsEnd < buf.length
        && wsEnd <= MAX_LEADING_WHITESPACE
        && isWhitespaceChar(buf[wsEnd])
      ) {
        wsEnd++
      }
      if (wsEnd > MAX_LEADING_WHITESPACE) {
        state.leading = false
        break
      }
      if (wsEnd === buf.length) {
        state.buffer = buf
        return ""
      }
      const token = matchControlTokenAt(buf, wsEnd)
      if (token) {
        state.strippedLeading = true
        buf = buf.slice(wsEnd + token.length)
        continue
      }
      if (isIncompleteControlTokenPrefix(buf, wsEnd)) {
        state.buffer = buf
        return ""
      }
      state.leading = false
      break
    }

    let wsEnd = 0
    while (wsEnd < buf.length && isWhitespaceChar(buf[wsEnd])) {
      wsEnd++
    }
    if (wsEnd > 0) {
      buf = buf.slice(wsEnd)
    }
    if (buf.length === 0) {
      state.buffer = ""
      return ""
    }
    const token = matchControlTokenAt(buf, 0)
    if (token) {
      buf = buf.slice(token.length)
      continue
    }
    if (isIncompleteControlTokenPrefix(buf, 0)) {
      state.buffer = buf
      return ""
    }
    state.leading = false
    break
  }

  const holdIndex = findTrailingHoldIndex(buf, false)
  const emitted = buf.slice(0, holdIndex)
  state.buffer = trimOverflowHoldBuffer(buf.slice(holdIndex))
  return emitted
}

export function finishGeminiTextSanitizer(
  state: GeminiTextSanitizerState,
): string {
  const remaining = state.buffer
  state.leading = true
  state.strippedLeading = false
  state.buffer = ""
  if (remaining.length === 0) {
    return ""
  }
  const holdIndex = findTrailingHoldIndex(remaining, true)
  return remaining.slice(0, holdIndex)
}

export function stripGeminiControlTokens(text: string): string {
  if (!text.includes("<")) {
    return text
  }
  const state = createGeminiTextSanitizerState()
  return pushGeminiTextChunk(state, text) + finishGeminiTextSanitizer(state)
}
