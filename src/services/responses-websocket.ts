import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { WebSocket } from "undici"

export interface PooledWebSocketRequest<TPayload> {
  headers: Record<string, string>
  payload: TPayload
  poolKey: string
  url: string
}

export interface PooledWebSocketStreamOptions<TChunk> {
  createChunk: (data: string) => TChunk
  idleTimeoutMs?: number
  isTerminalChunk: (chunk: TChunk) => boolean
  openErrorMessage: string
  streamErrorMessage: string
  terminalChunkMissingMessage: string
  unavailableErrorMessage?: string
}

type WebSocketErrorEvent = Parameters<
  NonNullable<InstanceType<typeof WebSocket>["onerror"]>
>[0]

const DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS = 60_000

const websocketPool = new Map<string, PooledWebSocketEntry>()
const websocketActiveRequests = new Map<string, number>()

interface PooledWebSocketEntry {
  closed: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  requestCount: number
  websocketPromise: Promise<InstanceType<typeof WebSocket>>
}

interface PooledWebSocketRequestTarget {
  entry: PooledWebSocketEntry
  pooled: boolean
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
  const release = acquirePooledWebSocketEntry(
    request.poolKey,
    entry,
    pooled,
    options,
  )

  try {
    const websocket = await getReadyPooledWebSocket(
      request.poolKey,
      entry,
      pooled,
      options,
    )
    websocket.send(JSON.stringify(request.payload))

    for await (const data of createWebSocketMessageStream(websocket, options)) {
      const chunk = options.createChunk(data)
      yield chunk

      if (options.isTerminalChunk(chunk)) {
        return
      }
    }

    removePooledWebSocketEntry(request.poolKey, entry)
    throw new Error(options.terminalChunkMissingMessage)
  } catch (error) {
    removePooledWebSocketEntry(request.poolKey, entry)
    throw toError(error)
  } finally {
    release()
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
    clearPooledWebSocketIdleTimer(existing)
    return {
      entry: existing,
      pooled: true,
    }
  }

  const entry = createPooledWebSocketEntry(request, options)
  websocketPool.set(request.poolKey, entry)
  return {
    entry,
    pooled: true,
  }
}

const createPooledWebSocketEntry = <TPayload, TChunk>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
): PooledWebSocketEntry => {
  const entry: PooledWebSocketEntry = {
    closed: false,
    idleTimer: null,
    requestCount: 0,
    websocketPromise: openWebSocket({
      headers: request.headers,
      openErrorMessage: options.openErrorMessage,
      url: request.url,
    }),
  }

  entry.websocketPromise
    .then((websocket) => {
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

const acquirePooledWebSocketEntry = <TChunk>(
  poolKey: string,
  entry: PooledWebSocketEntry,
  pooled: boolean,
  options: PooledWebSocketStreamOptions<TChunk>,
): (() => void) => {
  clearPooledWebSocketIdleTimer(entry)
  incrementPooledWebSocketActiveRequestCount(poolKey)
  entry.requestCount += 1

  let released = false
  return () => {
    if (released) {
      return
    }

    released = true
    entry.requestCount -= 1

    decrementPooledWebSocketActiveRequestCount(poolKey)
    if (entry.closed || entry.requestCount > 0) {
      return
    }

    if (pooled && websocketPool.get(poolKey) === entry) {
      schedulePooledWebSocketIdleClose(poolKey, entry, options)
      return
    }

    removePooledWebSocketEntry(poolKey, entry)
  }
}

const getReadyPooledWebSocket = async (
  poolKey: string,
  entry: PooledWebSocketEntry,
  pooled: boolean,
  options?: { unavailableErrorMessage?: string },
): Promise<InstanceType<typeof WebSocket>> => {
  const unavailableErrorMessage =
    options?.unavailableErrorMessage
    ?? "Websocket connection became unavailable before the request started"

  if (entry.closed) {
    throw new Error(unavailableErrorMessage)
  }

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

const schedulePooledWebSocketIdleClose = <TChunk>(
  poolKey: string,
  entry: PooledWebSocketEntry,
  options: PooledWebSocketStreamOptions<TChunk>,
): void => {
  clearPooledWebSocketIdleTimer(entry)
  entry.idleTimer = setTimeout(() => {
    removePooledWebSocketEntry(poolKey, entry)
  }, options.idleTimeoutMs ?? DEFAULT_WEBSOCKET_IDLE_TIMEOUT_MS)
  unrefTimer(entry.idleTimer)
}

const clearPooledWebSocketIdleTimer = (entry: PooledWebSocketEntry): void => {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
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
    return
  }

  websocketActiveRequests.set(poolKey, nextCount)
}

const removePooledWebSocketEntry = (
  poolKey: string,
  entry: PooledWebSocketEntry,
): void => {
  if (websocketPool.get(poolKey) === entry) {
    websocketPool.delete(poolKey)
  }

  if (entry.closed) {
    return
  }

  entry.closed = true
  clearPooledWebSocketIdleTimer(entry)
  entry.websocketPromise.then(closeWebSocket).catch(() => {})
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (
    typeof timer === "object"
    && "unref" in timer
    && typeof timer.unref === "function"
  ) {
    timer.unref()
  }
}

const createWebSocketError = (
  message: string,
  event?: Pick<WebSocketErrorEvent, "error" | "message">,
): Error => {
  const reason = event?.error ?? event?.message
  if (reason === undefined || reason === "") {
    return new Error(message)
  }

  const cause = toError(reason)
  return new Error(`${message}: ${cause.message}`, { cause })
}

const openWebSocket = async ({
  headers,
  openErrorMessage,
  url,
}: {
  headers: Record<string, string>
  openErrorMessage: string
  url: string
}): Promise<InstanceType<typeof WebSocket>> =>
  await new Promise((resolve, reject) => {
    const proxy = typeof Bun === "undefined" ? undefined : getProxyUrl(url)
    const init = { headers, ...(proxy ? { proxy } : {}) }
    const websocket = new WebSocket(url, init)

    const cleanup = () => {
      websocket.removeEventListener("open", onOpen)
      websocket.removeEventListener("error", onError)
    }

    const onOpen = () => {
      cleanup()
      resolve(websocket)
    }

    const onError = (event: WebSocketErrorEvent) => {
      cleanup()
      reject(createWebSocketError(openErrorMessage, event))
    }

    websocket.addEventListener("open", onOpen)
    websocket.addEventListener("error", onError)
  })

const createWebSocketMessageStream = async function* <TChunk>(
  websocket: InstanceType<typeof WebSocket>,
  options: PooledWebSocketStreamOptions<TChunk>,
): AsyncIterable<string> {
  const queue: Array<Promise<string>> = []
  let closed = false
  let error: Error | null = null
  let notify: (() => void) | null = null

  const wake = () => {
    notify?.()
    notify = null
  }

  const onMessage = (event: { data: unknown }) => {
    queue.push(normalizeWebSocketMessageData(event.data))
    wake()
  }

  const onClose = () => {
    closed = true
    wake()
  }

  const onError = (event: WebSocketErrorEvent) => {
    error = createWebSocketError(options.streamErrorMessage, event)
    wake()
  }

  websocket.addEventListener("message", onMessage)
  websocket.addEventListener("close", onClose)
  websocket.addEventListener("error", onError)

  try {
    while (true) {
      const item = queue.shift()
      if (item) {
        yield await item
        continue
      }

      if (error) {
        throw toError(error)
      }

      if (closed) {
        break
      }

      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }
  } finally {
    websocket.removeEventListener("message", onMessage)
    websocket.removeEventListener("close", onClose)
    websocket.removeEventListener("error", onError)
  }
}

const normalizeWebSocketMessageData = async (
  data: unknown,
): Promise<string> => {
  if (typeof data === "string") {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }

  if (ArrayBuffer.isView(data)) {
    const view = data
    return new TextDecoder().decode(
      new Uint8Array(
        view.buffer as ArrayBuffer,
        view.byteOffset,
        view.byteLength,
      ),
    )
  }

  if (isTextReadable(data)) {
    return await data.text()
  }

  return String(data)
}

const isTextReadable = (
  value: unknown,
): value is { text: () => Promise<string> } => {
  if (!value || typeof value !== "object" || !("text" in value)) {
    return false
  }

  return typeof (value as { text?: unknown }).text === "function"
}

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value
  }

  return new Error(String(value))
}

const closeWebSocket = (websocket: InstanceType<typeof WebSocket>): void => {
  if (
    websocket.readyState === WebSocket.CONNECTING
    || websocket.readyState === WebSocket.OPEN
  ) {
    websocket.close()
  }
}

const getProxyUrl = (url: string): string => {
  return getProxyForUrl(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"))
}
