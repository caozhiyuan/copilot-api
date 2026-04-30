import { utilityProcess, app } from 'electron'
import type { UtilityProcess } from 'electron'
import net from 'node:net'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { ServerStatus } from '../src/types/ipc'
import { tMain } from './i18n'

let serverProcess: UtilityProcess | null = null
let currentPort = 4141
let statusCallback: ((status: ServerStatus) => void) | null = null
let logCallback: ((log: string) => void) | null = null
// Ring buffer for logs, capped at 2000 entries for log panel replay.
const LOG_BUFFER_MAX = 2000
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

function skipStringTerminatedSequence(input: string, startIndex: number): number {
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

    if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
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
    handleData(data: Buffer) {
      emitLog(decoder.write(data))
    },
    flush() {
      if (flushed) return
      flushed = true
      emitLog(decoder.end())
    }
  }
}

export function onStatusChange(cb: (status: ServerStatus) => void): void {
  statusCallback = cb
}

export function onLog(cb: (log: string) => void): void {
  logCallback = cb
}

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    // Bind to 0.0.0.0 to check whether the port is occupied on any interface.
    server.listen(port, '0.0.0.0')
  })
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  // In development, use dist/main.js from the project root.
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

export async function startServer(
  port: number,
  token: string,
  serverOptions?: { accountType?: string; verbose?: boolean; showToken?: boolean }
): Promise<ServerStatus> {
  const available = await checkPortAvailable(port)
  if (!available) {
    return {
      running: false,
      error: await tMain('server.portInUse', { port })
    }
  }

  if (serverProcess) {
    await stopServer()
  }

  currentPort = port

  // Clear the previous log buffer before each new server start.
  logBuffer.length = 0

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production'
  }

  const serverPath = getServerPath()
  const args = ['start', '--github-token', token, '--port', String(port)]
  if (serverOptions?.accountType && serverOptions.accountType !== 'individual') {
    args.push('--account-type', serverOptions.accountType)
  }
  if (serverOptions?.verbose) args.push('--verbose')
  if (serverOptions?.showToken) args.push('--show-token')

  // utilityProcess.fork is an official Electron API and does not start another
  // Electron instance, so packaged macOS builds do not show a second Dock icon.
  serverProcess = utilityProcess.fork(serverPath, args, {
    env,
    stdio: 'pipe',
    serviceName: 'copilot-api-server'
  })

  // Decode streamed UTF-8 safely so chunk boundaries do not corrupt Chinese or box-drawing characters.
  const stdoutLogStream = createLogStream()
  const stderrLogStream = createLogStream()

  serverProcess.stdout?.on('data', stdoutLogStream.handleData)
  serverProcess.stdout?.once('end', stdoutLogStream.flush)
  serverProcess.stdout?.once('close', stdoutLogStream.flush)
  serverProcess.stderr?.on('data', stderrLogStream.handleData)
  serverProcess.stderr?.once('end', stderrLogStream.flush)
  serverProcess.stderr?.once('close', stderrLogStream.flush)

  // Wait for the server to become ready while also detecting early process exit.
  const startResult = await waitForServer(port, serverProcess)
  if (!startResult.ok) {
    if (serverProcess) {
      serverProcess.kill()
      serverProcess = null
    }
    const msg = startResult.exitCode !== undefined
      ? await tMain('server.startFailed', { code: startResult.exitCode })
      : await tMain('server.startTimeout', { port })
    return { running: false, error: msg }
  }

  // Register the runtime exit handler only after startup succeeds.
  serverProcess!.on('exit', (code) => {
    stdoutLogStream.flush()
    stderrLogStream.flush()
    serverProcess = null

    if (code === 0) {
      statusCallback?.({ running: false })
      return
    }

    void tMain('server.processExit', { code: String(code ?? 'unknown') }).then((error) => {
      statusCallback?.({
        running: false,
        error
      })
    })
  })

  return { running: true, port }
}

// Wait for server readiness or process exit, whichever happens first.
async function waitForServer(
  port: number,
  proc: UtilityProcess
): Promise<{ ok: boolean; exitCode?: number }> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (result: { ok: boolean; exitCode?: number }) => {
      if (settled) return
      settled = true
      proc.removeListener('exit', onExit)
      resolve(result)
    }

    const onExit = (code: number) => {
      finish({ ok: false, exitCode: code ?? undefined })
    }

    proc.once('exit', onExit)

    ;(async () => {
      const url = `http://localhost:${port}/`
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

export async function stopServer(): Promise<void> {
  if (!serverProcess) return
  serverProcess.kill()
  serverProcess = null
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

export function getLogs(): string[] {
  return [...logBuffer]
}
