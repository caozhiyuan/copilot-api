import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { WebSocket } from "undici"

export interface PooledWebSocketRequest<TPayload> {
  headers: Record<string, string>
  payload: TPayload
  poolKey: string
  signal?: AbortSignal
  url: string
}

export interface PooledWebSocketStreamOptions<TChunk> {
  createChunk: (data: string) => TChunk
  isTerminalChunk: (chunk: TChunk) => boolean
  maxBufferedBytes: number
  maxBufferedMessages: number
  openErrorMessage: string
  openTimeoutMs: number
  poolIdleTimeoutMs: number
  streamErrorMessage: string
  streamInactivityTimeoutMs: number
  terminalChunkMissingMessage: string
  unavailableErrorMessage?: string
}

type WebSocketInstance = InstanceType<typeof WebSocket>
type WebSocketErrorEvent = Parameters<
  NonNullable<WebSocketInstance["onerror"]>
>[0]
type WebSocketMessageListener = (event: { data: unknown }) => void

const websocketPool = new Map<string, PooledWebSocketEntry>()
const websocketActiveRequests = new Map<string, number>()

interface PooledWebSocketEntry {
  closed: boolean
  idleMessageListener: WebSocketMessageListener | null
  idleTimer: ReturnType<typeof setTimeout> | null
  poolIdleTimeoutMs: number
  requestCount: number
  websocket: WebSocketInstance | null
  websocketPromise: Promise<WebSocketInstance>
}

interface PooledWebSocketRequestTarget {
  entry: PooledWebSocketEntry
  pooled: boolean
}

interface BufferedWebSocketMessage {
  data: Promise<string>
  size: number
}

export class ResponsesWebSocketOpenTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Responses websocket did not open within ${timeoutMs}ms`)
    this.name = "ResponsesWebSocketOpenTimeoutError"
  }
}

export class ResponsesWebSocketInactivityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Responses websocket stream was inactive for ${timeoutMs}ms`)
    this.name = "ResponsesWebSocketInactivityTimeoutError"
  }
}

export class ResponsesWebSocketBufferOverflowError extends Error {
  constructor(maxBufferedBytes: number, maxBufferedMessages: number) {
    super(
      `Responses websocket buffer exceeded ${maxBufferedBytes} bytes or ${maxBufferedMessages} messages; downstream consumption is too slow`,
    )
    this.name = "ResponsesWebSocketBufferOverflowError"
  }
}

export class WebSocketMessageBuffer {
  private readonly entries: Array<BufferedWebSocketMessage | undefined> = []
  private head = 0
  private readonly maxBufferedBytes: number
  private readonly maxBufferedMessages: number
  private sizeBytes = 0

  constructor(maxBufferedBytes: number, maxBufferedMessages: number) {
    this.maxBufferedBytes = maxBufferedBytes
    this.maxBufferedMessages = maxBufferedMessages
  }

  get bufferedBytes(): number {
    return this.sizeBytes
  }

  get bufferedMessages(): number {
    return this.entries.length - this.head
  }

  enqueue(data: unknown): boolean {
    const size = getWebSocketMessageSize(data)
    if (
      this.sizeBytes + size > this.maxBufferedBytes
      || this.bufferedMessages + 1 > this.maxBufferedMessages
    ) {
      return false
    }

    this.entries.push({
      data: normalizeWebSocketMessageData(data),
      size,
    })
    this.sizeBytes += size
    return true
  }

  dequeue(): Promise<string> | undefined {
    const entry = this.entries[this.head]
    if (!entry) return undefined

    this.entries[this.head] = undefined
    this.head += 1
    this.sizeBytes -= entry.size
    this.compactIfNeeded()
    return entry.data
  }

  clear(): void {
    this.entries.length = 0
    this.head = 0
    this.sizeBytes = 0
  }

  private compactIfNeeded(): void {
    if (this.head < 256 || this.head * 2 < this.entries.length) return
    this.entries.splice(0, this.head)
    this.head = 0
  }
}

export const createWebSocketUrl = (url: string): string => {
  const websocketUrl = new URL(url)

  if (websocketUrl.protocol === "https:") {
    websocketUrl.protocol = "wss:"
  } else if (websocketUrl.protocol === "http:") {
    websocketUrl.protocol = "ws:"
  }

  return websocketUrl.toString()
}

export const createPooledWebSocketStream = <TPayload, TChunk>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
): AsyncIterable<TChunk> => runPooledWebSocketRequest(request, options)

const runPooledWebSocketRequest = async function* <TPayload, TChunk>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
): AsyncIterable<TChunk> {
  const { entry, pooled } = getPooledWebSocketRequestTarget(request, options)
  const release = acquirePooledWebSocketEntry(request.poolKey, entry, pooled)
  let messageStream: WebSocketMessageStream | null = null
  let reusable = false

  try {
    const websocket = await getReadyPooledWebSocket(
      request.poolKey,
      entry,
      pooled,
      options,
    )
    messageStream = createWebSocketMessageStream(
      websocket,
      request.signal,
      options,
    )
    messageStream.start()
    websocket.send(JSON.stringify(request.payload))

    for await (const data of messageStream.iterable) {
      const chunk = options.createChunk(data)
      yield chunk

      if (options.isTerminalChunk(chunk)) {
        messageStream.complete()
        reusable = true
        return
      }
    }

    throw new Error(options.terminalChunkMissingMessage)
  } catch (error) {
    throw toError(error)
  } finally {
    messageStream?.dispose()
    if (!reusable) removePooledWebSocketEntry(request.poolKey, entry)
    release(reusable)
  }
}

const getPooledWebSocketRequestTarget = <TPayload, TChunk>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
): PooledWebSocketRequestTarget => {
  if (getPooledWebSocketActiveRequestCount(request.poolKey) > 0) {
    return {
      entry: createPooledWebSocketEntry(request, options),
      pooled: false,
    }
  }

  const existing = websocketPool.get(request.poolKey)
  if (existing && !existing.closed) {
    consola.debug("websocket from pool")
    clearPooledWebSocketIdleState(existing)
    return { entry: existing, pooled: true }
  }

  const entry = createPooledWebSocketEntry(request, options)
  websocketPool.set(request.poolKey, entry)
  return { entry, pooled: true }
}

const createPooledWebSocketEntry = <TPayload, TChunk>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
): PooledWebSocketEntry => {
  const websocketPromise = openWebSocket({
    headers: request.headers,
    openErrorMessage: options.openErrorMessage,
    openTimeoutMs: options.openTimeoutMs,
    signal: request.signal,
    url: request.url,
  })
  const entry: PooledWebSocketEntry = {
    closed: false,
    idleMessageListener: null,
    idleTimer: null,
    poolIdleTimeoutMs: options.poolIdleTimeoutMs,
    requestCount: 0,
    websocket: null,
    websocketPromise,
  }

  entry.websocketPromise
    .then((websocket) => {
      entry.websocket = websocket
      websocket.addEventListener("close", () => {
        removePooledWebSocketEntry(request.poolKey, entry)
      })
      websocket.addEventListener("error", () => {
        removePooledWebSocketEntry(request.poolKey, entry)
      })
    })
    .catch(() => {
      removePooledWebSocketEntry(request.poolKey, entry)
    })

  return entry
}

const acquirePooledWebSocketEntry = (
  poolKey: string,
  entry: PooledWebSocketEntry,
  pooled: boolean,
): ((reusable: boolean) => void) => {
  clearPooledWebSocketIdleState(entry)
  incrementPooledWebSocketActiveRequestCount(poolKey)
  entry.requestCount += 1

  let released = false
  return (reusable) => {
    if (released) return
    released = true
    entry.requestCount -= 1
    decrementPooledWebSocketActiveRequestCount(poolKey)

    if (!reusable) {
      removePooledWebSocketEntry(poolKey, entry)
      return
    }
    if (entry.closed || entry.requestCount > 0) return

    if (pooled && websocketPool.get(poolKey) === entry) {
      schedulePooledWebSocketIdleClose(poolKey, entry)
      return
    }

    removePooledWebSocketEntry(poolKey, entry)
  }
}

const getReadyPooledWebSocket = async <TChunk>(
  poolKey: string,
  entry: PooledWebSocketEntry,
  pooled: boolean,
  options: PooledWebSocketStreamOptions<TChunk>,
): Promise<WebSocketInstance> => {
  const unavailableErrorMessage =
    options.unavailableErrorMessage
    ?? "Websocket connection became unavailable before the request started"

  if (entry.closed) throw new Error(unavailableErrorMessage)

  const websocket = await entry.websocketPromise
  if (entry.closed || (pooled && websocketPool.get(poolKey) !== entry)) {
    throw new Error(unavailableErrorMessage)
  }
  if (websocket.readyState !== WebSocket.OPEN) {
    removePooledWebSocketEntry(poolKey, entry)
    throw new Error(unavailableErrorMessage)
  }

  return websocket
}

const schedulePooledWebSocketIdleClose = (
  poolKey: string,
  entry: PooledWebSocketEntry,
): void => {
  clearPooledWebSocketIdleState(entry)
  const websocket = entry.websocket
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    removePooledWebSocketEntry(poolKey, entry)
    return
  }

  entry.idleMessageListener = () => {
    removePooledWebSocketEntry(poolKey, entry)
  }
  websocket.addEventListener("message", entry.idleMessageListener)

  entry.idleTimer = setTimeout(() => {
    removePooledWebSocketEntry(poolKey, entry)
  }, entry.poolIdleTimeoutMs)
  unrefTimer(entry.idleTimer)
}

const clearPooledWebSocketIdleState = (entry: PooledWebSocketEntry): void => {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
  if (entry.websocket && entry.idleMessageListener) {
    entry.websocket.removeEventListener("message", entry.idleMessageListener)
    entry.idleMessageListener = null
  }
}

const getPooledWebSocketActiveRequestCount = (poolKey: string): number =>
  websocketActiveRequests.get(poolKey) ?? 0

const incrementPooledWebSocketActiveRequestCount = (poolKey: string): void => {
  websocketActiveRequests.set(
    poolKey,
    getPooledWebSocketActiveRequestCount(poolKey) + 1,
  )
}

const decrementPooledWebSocketActiveRequestCount = (poolKey: string): void => {
  const nextCount = getPooledWebSocketActiveRequestCount(poolKey) - 1
  if (nextCount <= 0) {
    websocketActiveRequests.delete(poolKey)
  } else {
    websocketActiveRequests.set(poolKey, nextCount)
  }
}

const removePooledWebSocketEntry = (
  poolKey: string,
  entry: PooledWebSocketEntry,
): void => {
  if (websocketPool.get(poolKey) === entry) websocketPool.delete(poolKey)
  if (entry.closed) return

  entry.closed = true
  clearPooledWebSocketIdleState(entry)
  entry.websocketPromise.then(closeWebSocket).catch(() => {})
}

const createWebSocketError = (
  message: string,
  event?: Pick<WebSocketErrorEvent, "error" | "message">,
): Error => {
  const reason = event?.error ?? event?.message
  if (reason === undefined || reason === "") return new Error(message)

  const cause = toError(reason)
  return new Error(`${message}: ${cause.message}`, { cause })
}

const openWebSocket = async ({
  headers,
  openErrorMessage,
  openTimeoutMs,
  signal,
  url,
}: {
  headers: Record<string, string>
  openErrorMessage: string
  openTimeoutMs: number
  signal?: AbortSignal
  url: string
}): Promise<WebSocketInstance> =>
  await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortReason(signal.reason))
      return
    }

    const proxy = typeof Bun === "undefined" ? undefined : getProxyUrl(url)
    const init = { headers, ...(proxy ? { proxy } : {}) }
    const websocket = new WebSocket(url, init)
    let settled = false
    const timer = setTimeout(() => {
      fail(new ResponsesWebSocketOpenTimeoutError(openTimeoutMs))
    }, openTimeoutMs)
    unrefTimer(timer)

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      websocket.removeEventListener("open", onOpen)
      websocket.removeEventListener("close", onClose)
      websocket.removeEventListener("error", onError)
    }

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      closeWebSocket(websocket)
      reject(error)
    }

    const onAbort = () => fail(toAbortReason(signal?.reason))
    const onOpen = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(websocket)
    }
    const onClose = () => fail(new Error(openErrorMessage))
    const onError = (event: WebSocketErrorEvent) => {
      fail(createWebSocketError(openErrorMessage, event))
    }

    signal?.addEventListener("abort", onAbort, { once: true })
    websocket.addEventListener("open", onOpen)
    websocket.addEventListener("close", onClose)
    websocket.addEventListener("error", onError)
  })

interface WebSocketMessageStream {
  complete: () => void
  dispose: () => void
  iterable: AsyncIterable<string>
  start: () => void
}

const createWebSocketMessageStream = <TChunk>(
  websocket: WebSocketInstance,
  signal: AbortSignal | undefined,
  options: PooledWebSocketStreamOptions<TChunk>,
): WebSocketMessageStream => {
  const buffer = new WebSocketMessageBuffer(
    options.maxBufferedBytes,
    options.maxBufferedMessages,
  )
  let closed = false
  let disposed = false
  let error: Error | null = null
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null
  let notify: (() => void) | null = null

  const wake = () => {
    notify?.()
    notify = null
  }

  const clearInactivityTimer = () => {
    if (!inactivityTimer) return
    clearTimeout(inactivityTimer)
    inactivityTimer = null
  }

  const fail = (nextError: Error, close = true) => {
    if (error || disposed) return
    error = nextError
    clearInactivityTimer()
    buffer.clear()
    if (close) closeWebSocket(websocket)
    wake()
  }

  const resetInactivityTimer = () => {
    clearInactivityTimer()
    if (disposed || closed || error) return
    inactivityTimer = setTimeout(() => {
      fail(
        new ResponsesWebSocketInactivityTimeoutError(
          options.streamInactivityTimeoutMs,
        ),
      )
    }, options.streamInactivityTimeoutMs)
    unrefTimer(inactivityTimer)
  }

  const onMessage = (event: { data: unknown }) => {
    resetInactivityTimer()
    if (!buffer.enqueue(event.data)) {
      fail(
        new ResponsesWebSocketBufferOverflowError(
          options.maxBufferedBytes,
          options.maxBufferedMessages,
        ),
      )
      return
    }
    wake()
  }

  const onClose = () => {
    consola.debug("WebSocket closed")
    closed = true
    clearInactivityTimer()
    wake()
  }

  const onError = (event: WebSocketErrorEvent) => {
    consola.error("WebSocket error:", event, event.error)
    fail(createWebSocketError(options.streamErrorMessage, event), false)
  }

  const onAbort = () => fail(toAbortReason(signal?.reason))

  websocket.addEventListener("message", onMessage)
  websocket.addEventListener("close", onClose)
  websocket.addEventListener("error", onError)
  signal?.addEventListener("abort", onAbort, { once: true })

  const dispose = () => {
    if (disposed) return
    disposed = true
    clearInactivityTimer()
    buffer.clear()
    websocket.removeEventListener("message", onMessage)
    websocket.removeEventListener("close", onClose)
    websocket.removeEventListener("error", onError)
    signal?.removeEventListener("abort", onAbort)
    wake()
  }

  const iterable = (async function* (): AsyncIterable<string> {
    try {
      while (true) {
        const item = buffer.dequeue()
        if (item) {
          yield await item
          continue
        }
        if (error) throw toError(error)
        if (closed) return

        await new Promise<void>((resolve) => {
          notify = resolve
        })
      }
    } finally {
      dispose()
    }
  })()

  return {
    complete: clearInactivityTimer,
    dispose,
    iterable,
    start: resetInactivityTimer,
  }
}

const normalizeWebSocketMessageData = async (
  data: unknown,
): Promise<string> => {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(
        data.buffer as ArrayBuffer,
        data.byteOffset,
        data.byteLength,
      ),
    )
  }
  if (isTextReadable(data)) return await data.text()
  return String(data)
}

const getWebSocketMessageSize = (data: unknown): number => {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  if (isSized(data)) return data.size
  return new TextEncoder().encode(String(data)).byteLength
}

const isTextReadable = (
  value: unknown,
): value is { text: () => Promise<string> } =>
  Boolean(
    value
      && typeof value === "object"
      && "text" in value
      && typeof (value as { text?: unknown }).text === "function",
  )

const isSized = (value: unknown): value is { size: number } =>
  Boolean(
    value
      && typeof value === "object"
      && "size" in value
      && typeof (value as { size?: unknown }).size === "number",
  )

const toAbortReason = (reason: unknown): Error => {
  if (reason instanceof Error) return reason
  const error = new Error("The operation was aborted")
  error.name = "AbortError"
  return error
}

const toError = (value: unknown): Error => {
  if (value instanceof Error) return value
  return new Error(String(value))
}

const closeWebSocket = (websocket: WebSocketInstance): void => {
  if (
    websocket.readyState !== WebSocket.CONNECTING
    && websocket.readyState !== WebSocket.OPEN
  ) {
    return
  }
  try {
    websocket.close()
  } catch {
    // Some implementations reject close() while CONNECTING. The open
    // listeners have already been detached, so the socket cannot be reused.
  }
}

const getProxyUrl = (url: string): string =>
  getProxyForUrl(url.replace(/^wss:/u, "https:").replace(/^ws:/u, "http:"))

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (
    typeof timer === "object"
    && "unref" in timer
    && typeof timer.unref === "function"
  ) {
    timer.unref()
  }
}
