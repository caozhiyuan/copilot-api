import { utilityProcess, app } from 'electron'
import childProcess from 'node:child_process'
import type { EventEmitter } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type {
  DesktopProxySettings,
  ServerRuntime,
  ServerStatus,
} from '../src/types/ipc'
import {
  DEFAULT_SERVER_HOST,
  formatServerUrl,
  isInvalidBindErrorCode,
  normalizeServerHostname,
  resolveClientHostnameOrDefault,
} from '../../src/lib/server-host'
import { applyDesktopProxySettingsToEnv } from './electron-proxy-config'
import { detectBunRuntime } from './bun-runtime'
import { tMain } from './i18n'
import { buildServerStartArgs, buildServerStartEnv } from './server-start-args'

interface ServerProcess extends EventEmitter {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill: (signal?: NodeJS.Signals) => boolean
}

let serverProcess: ServerProcess | null = null
let currentPort = 4141
let currentHost = ''
let statusCallback: ((status: ServerStatus) => void) | null = null
let logCallback: ((log: string) => void) | null = null
// Ring buffer for logs, capped at 2000 entries for log panel replay.
const LOG_BUFFER_MAX = 2000
const STOP_TIMEOUT_MS = 5000
const logBuffer: string[] = []
const ESC_CHAR_CODE = 27
const BEL_CHAR_CODE = 7
const CSI_CHAR_CODE = 0x9b

function codeAt(input: string, index: number): number {
  return input.codePointAt(index) ?? -1
}

function skipCsiSequence(input: string, startIndex: number): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    index += 1
  }

  return inputLength
}

function skipStringTerminatedSequence(
  input: string,
  startIndex: number,
): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)

    if (code === BEL_CHAR_CODE) return index + 1
    if (code === ESC_CHAR_CODE && codeAt(input, index + 1) === 92) {
      return Math.min(index + 2, inputLength)
    }

    index += 1
  }

  return inputLength
}

function stripAnsi(input: string): string {
  const inputLength = input.length
  let lastIndex = 0
  let index = 0
  let stripped = false
  const parts: Array<string> = []

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code !== ESC_CHAR_CODE && code !== CSI_CHAR_CODE) {
      index += 1
      continue
    }

    stripped = true
    if (index > lastIndex) parts.push(input.slice(lastIndex, index))

    if (code === CSI_CHAR_CODE) {
      index = skipCsiSequence(input, index + 1)
      lastIndex = index
      continue
    }

    const next = input[index + 1]
    if (next === '[') {
      index = skipCsiSequence(input, index + 2)
      lastIndex = index
      continue
    }

    if (
      next === ']'
      || next === 'P'
      || next === 'X'
      || next === '^'
      || next === '_'
    ) {
      index = skipStringTerminatedSequence(input, index + 2)
      lastIndex = index
      continue
    }

    index = Math.min(index + 2, inputLength)
    lastIndex = index
  }

  if (!stripped) return input
  if (lastIndex < inputLength) parts.push(input.slice(lastIndex))
  return parts.join('')
}

function emitLog(message: string): void {
  const sanitizedMessage = stripAnsi(message)
  if (sanitizedMessage.length === 0) return

  logBuffer.push(sanitizedMessage)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
  logCallback?.(sanitizedMessage)
}

function createLogStream() {
  const decoder = new StringDecoder('utf8')
  let flushed = false

  return {
    handleData: (data: Buffer) => {
      emitLog(decoder.write(data))
    },
    flush: () => {
      if (flushed) return
      flushed = true
      emitLog(decoder.end())
    },
  }
}

export function onStatusChange(cb: (status: ServerStatus) => void): void {
  statusCallback = cb
}

export function onLog(cb: (log: string) => void): void {
  logCallback = cb
}

type PortProbeResult = { available: true } | { available: false; code?: string }

function checkPortAvailable(
  port: number,
  hostname: string,
): Promise<PortProbeResult> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: NodeJS.ErrnoException) =>
      resolve({ available: false, code: err?.code }),
    )
    server.once('listening', () => {
      server.close()
      resolve({ available: true })
    })
    // Probe the address the server process will actually bind. A wildcard
    // probe refuses hosts the server could still bind (::1 or 127.0.0.1 while
    // another process holds 0.0.0.0) and misses loopback-only listeners.
    server.listen(port, hostname)
  })
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  // In development, use dist/main.js from the project root.
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

interface ServerStartOptions {
  runtime?: ServerRuntime
  verbose?: boolean
  showToken?: boolean
  host?: string
  proxy?: DesktopProxySettings
}

export async function startServer(
  port: number,
  serverOptions?: ServerStartOptions,
): Promise<ServerStatus> {
  const host = serverOptions?.host?.trim() ?? ''
  let bindHostname: string
  try {
    bindHostname = host ? normalizeServerHostname(host) : DEFAULT_SERVER_HOST
  } catch {
    return {
      running: false,
      error: await tMain('server.invalidHost'),
    }
  }
  // Resolve the runtime before stopping a healthy server. Never use an old Bun.
  const bun =
    serverOptions?.runtime !== 'node' ? await detectBunRuntime() : null
  // Validate the host before touching a running server, so an invalid host
  // never stops a healthy instance.
  // When the port changes, a conflicting listener cannot be our own
  // previous instance. Probe first so an occupied new port fails fast
  // without stopping the running server. The same-port case still stops
  // first, because our own listener would otherwise report as a conflict
  // (including wildcard/loopback overlap on the same port).
  if (serverProcess && port !== currentPort) {
    const preProbe = await checkPortAvailable(port, bindHostname)
    if (!preProbe.available) {
      if (isInvalidBindErrorCode(preProbe.code)) {
        return {
          running: false,
          error: await tMain('server.invalidHost'),
        }
      }
      return {
        running: false,
        error: await tMain('server.portInUse', { port }),
      }
    }
  }

  const restarting = serverProcess !== null
  if (restarting) {
    statusCallback?.({ running: false, restarting: true })
  }

  try {
    // A planned restart must not emit an unexpected-stop event.
    await stopServerProcess(false)
    const status = await launchServer(
      port,
      host,
      bindHostname,
      serverOptions,
      bun,
    )
    if (status.running || restarting) statusCallback?.(status)
    return status
  } catch (error) {
    if (restarting) {
      statusCallback?.({
        running: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}

async function launchServer(
  port: number,
  host: string,
  bindHostname: string,
  serverOptions?: ServerStartOptions,
  bun?: Awaited<ReturnType<typeof detectBunRuntime>> | null,
): Promise<ServerStatus> {
  const probe = await checkPortAvailable(port, bindHostname)
  if (!probe.available) {
    if (isInvalidBindErrorCode(probe.code)) {
      return {
        running: false,
        error: await tMain('server.invalidHost'),
      }
    }
    return {
      running: false,
      error: await tMain('server.portInUse', { port }),
    }
  }

  // Clear the previous log buffer before each new server start.
  logBuffer.length = 0

  const env = buildServerStartEnv(process.env)
  const proxyEnabled =
    serverOptions?.proxy ?
      applyDesktopProxySettingsToEnv(env, serverOptions.proxy)
    : false

  const serverPath = getServerPath()
  const args = buildServerStartArgs(port, host)
  if (proxyEnabled) args.push('--proxy-env')
  if (serverOptions?.verbose) args.push('--verbose')
  if (serverOptions?.showToken) args.push('--show-token')

  if (bun && !bun.available) emitLog(await tMain('server.bunFallback'))
  emitLog(
    await tMain('server.runtime', {
      runtime: bun?.available ? `Bun ${bun.version}` : 'Node.js (Electron)',
    }),
  )

  // Launch the bundled server directly; bunx would install an unrelated npm build.
  // The Node option keeps Electron's utility process and its bundled runtime.
  const proc: ServerProcess =
    bun?.available && bun.path ?
      childProcess.spawn(
        bun.path,
        ['--no-orphans', '--no-install', serverPath, ...args],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
    : utilityProcess.fork(serverPath, args, {
        env,
        stdio: 'pipe',
        serviceName: 'copilot-api-server',
      })
  serverProcess = proc

  // Decode streamed UTF-8 safely so chunk boundaries do not corrupt Chinese or box-drawing characters.
  const stdoutLogStream = createLogStream()
  const stderrLogStream = createLogStream()

  proc.stdout?.on('data', stdoutLogStream.handleData)
  proc.stdout?.once('end', stdoutLogStream.flush)
  proc.stdout?.once('close', stdoutLogStream.flush)
  proc.stderr?.on('data', stderrLogStream.handleData)
  proc.stderr?.once('end', stderrLogStream.flush)
  proc.stderr?.once('close', stderrLogStream.flush)

  // Wait for the server to become ready while also detecting early process exit.
  const startResult = await waitForServer(host, port, proc)
  if (!startResult.ok) {
    await waitForProcessExit(proc)
    stdoutLogStream.flush()
    stderrLogStream.flush()
    if (serverProcess === proc) {
      serverProcess = null
    }
    const msg =
      startResult.error ?
        await tMain('server.spawnFailed', {
          message: startResult.error.message,
        })
      : startResult.exitCode !== undefined ?
        await tMain('server.startFailed', { code: startResult.exitCode })
      : await tMain('server.startTimeout', { port })
    return { running: false, error: msg }
  }

  // Register the runtime exit handler only after startup succeeds.
  proc.on('exit', (code: number | null) => {
    stdoutLogStream.flush()
    stderrLogStream.flush()
    if (serverProcess !== proc) return

    serverProcess = null

    if (code === 0) {
      statusCallback?.({ running: false })
      return
    }

    void tMain('server.processExit', { code: String(code ?? 'unknown') }).then(
      (error) => {
        statusCallback?.({
          running: false,
          error,
        })
      },
    )
  })
  proc.on('error', (error: Error) => emitLog(error.message))

  currentPort = port
  currentHost = host

  const status: ServerStatus = { running: true, port, host }
  return status
}

// Wait for server readiness or process exit, whichever happens first.
async function waitForServer(
  host: string,
  port: number,
  proc: ServerProcess,
): Promise<{ ok: boolean; exitCode?: number; error?: Error }> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (result: {
      ok: boolean
      exitCode?: number
      error?: Error
    }) => {
      if (settled) return
      settled = true
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      resolve(result)
    }

    const onExit = (code: number | null) => {
      finish({ ok: false, exitCode: code ?? undefined })
    }
    const onError = (error: Error) => finish({ ok: false, error })

    proc.once('exit', onExit)
    proc.once('error', onError)

    ;(async () => {
      const url = `${formatServerUrl(resolveClientHostnameOrDefault(host), port)}/`
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((r) => setTimeout(r, 500))
        if (settled) return
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
          if (res.ok || res.status === 404) {
            finish({ ok: true })
            return
          }
        } catch {
          // Keep waiting.
        }
      }
      finish({ ok: false }) // Timed out.
    })().catch(() => finish({ ok: false }))
  })
}

function waitForProcessExit(proc: ServerProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    let forceTimeout: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forceTimeout)
      proc.removeListener('exit', onExit)
      resolve()
    }

    const onExit = () => finish()
    const timeout = setTimeout(() => {
      // External Bun processes can ignore SIGTERM; do not leave a server behind.
      if ('exitCode' in proc) {
        forceTimeout = setTimeout(finish, 1000)
        if (!proc.kill('SIGKILL')) finish()
      } else {
        finish()
      }
    }, STOP_TIMEOUT_MS)

    proc.once('exit', onExit)
    if (!proc.kill()) finish()
  })
}

async function stopServerProcess(notifyStatus: boolean): Promise<void> {
  if (!serverProcess) return
  const proc = serverProcess
  // Ignore the runtime exit handler for a process we deliberately stop,
  // including nonzero exit codes produced by termination on Windows.
  serverProcess = null
  await waitForProcessExit(proc)

  if (notifyStatus && !serverProcess) {
    statusCallback?.({ running: false, intentional: true })
  }
}

export async function stopServer(): Promise<void> {
  await stopServerProcess(true)
}

export function isRunning(): boolean {
  return serverProcess !== null
}

export function clearCallbacks(): void {
  statusCallback = null
  logCallback = null
}

export function getPort(): number {
  return currentPort
}

export function getHost(): string {
  return currentHost
}

export function getServerBaseUrl(): string {
  return formatServerUrl(
    resolveClientHostnameOrDefault(currentHost),
    currentPort,
  )
}

export function getLogs(): string[] {
  return [...logBuffer]
}
