import { utilityProcess, app } from 'electron'
import type { UtilityProcess } from 'electron'
import net from 'node:net'
import path from 'node:path'

import type { ServerStatus } from '../src/types/ipc'

let serverProcess: UtilityProcess | null = null
let currentPort = 4141
let statusCallback: ((status: ServerStatus) => void) | null = null
let logCallback: ((log: string) => void) | null = null
// 环形日志缓冲，最多保留 2000 条，供打开日志面板时回放
const LOG_BUFFER_MAX = 2000
const logBuffer: string[] = []

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
    // 绑定 0.0.0.0 以检测所有网络接口上的占用情况
    server.listen(port, '0.0.0.0')
  })
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  // 开发模式下使用项目根目录的 dist/main.js
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

export async function startServer(
  port: number,
  token: string,
  proxy?: { http?: string; https?: string },
  serverOptions?: { accountType?: string; verbose?: boolean; showToken?: boolean }
): Promise<ServerStatus> {
  const available = await checkPortAvailable(port)
  if (!available) {
    return { running: false, error: `端口 ${port} 已被占用，请更换其他端口` }
  }

  if (serverProcess) {
    await stopServer()
  }

  currentPort = port

  // 每次启动新服务时清空旧日志缓冲
  logBuffer.length = 0

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production'
  }

  if (proxy?.http) env.HTTP_PROXY = proxy.http
  if (proxy?.https) env.HTTPS_PROXY = proxy.https

  const serverPath = getServerPath()
  const args = ['start', '--github-token', token, '--port', String(port)]
  // 有代理配置时传 --proxy-env，让服务端从环境变量读取代理
  if (proxy?.http || proxy?.https) args.push('--proxy-env')
  if (serverOptions?.accountType && serverOptions.accountType !== 'individual') {
    args.push('--account-type', serverOptions.accountType)
  }
  if (serverOptions?.verbose) args.push('--verbose')
  if (serverOptions?.showToken) args.push('--show-token')

  // utilityProcess.fork 是 Electron 官方 API，不会创建新的 Electron 实例，
  // 在 macOS 打包后也不会出现第二个 Dock 图标
  serverProcess = utilityProcess.fork(serverPath, args, {
    env,
    stdio: 'pipe',
    serviceName: 'copilot-api-server'
  })

  const handleLog = (data: Buffer) => {
    const msg = data.toString()
    logBuffer.push(msg)
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
    logCallback?.(msg)
  }

  serverProcess.stdout?.on('data', handleLog)
  serverProcess.stderr?.on('data', handleLog)

  // 等待服务就绪（同时感知进程退出），启动失败时立即返回错误
  const startResult = await waitForServer(port, serverProcess)
  if (!startResult.ok) {
    if (serverProcess) {
      serverProcess.kill()
      serverProcess = null
    }
    const msg = startResult.exitCode !== undefined
      ? `服务进程启动失败（退出码 ${startResult.exitCode}），请查看日志`
      : `服务启动超时，端口 ${port} 可能已被占用`
    return { running: false, error: msg }
  }

  // 启动成功后再注册运行时异常退出的监听
  serverProcess!.on('exit', (code) => {
    serverProcess = null
    statusCallback?.({
      running: false,
      error: code !== 0 ? `进程退出，代码 ${code}` : undefined
    })
  })

  return { running: true, port }
}

// 等待服务就绪，同时监听进程退出，任一先发生就结束等待
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
          // 继续等待
        }
      }
      finish({ ok: false }) // 超时
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
