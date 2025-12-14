import * as net from "node:net"
import { Worker } from "node:worker_threads"
import * as vscode from "vscode"

type ServerStatus = "stopped" | "starting" | "running" | "stopping"

type WorkerMessage =
  | { type: "ready"; endpoint: string }
  | { type: "starting"; port: number }
  | { type: "error"; message: string; stack?: string }

interface ExtensionConfig {
  port: number
  verbose: boolean
  accountType: "individual" | "business" | "enterprise"
  rateLimitSeconds: number | null
  rateLimitWait: boolean
  proxyEnv: boolean
  showToken: boolean
}

let outputChannel: vscode.OutputChannel | undefined
let statusItem: vscode.StatusBarItem | undefined

let status: ServerStatus = "stopped"
let worker: Worker | undefined
let endpoint: string | undefined

function getServerStatus(): ServerStatus {
  return status
}

function setServerStopped(): void {
  status = "stopped"
  endpoint = undefined
  setStatus("Copilot API: Stopped", "copilotApi.start")
}

function setServerStarting(): void {
  status = "starting"
  setStatus("Copilot API: Starting...")
}

function setServerRunning(port: number): void {
  status = "running"
  setStatus(`Copilot API: Running (${port})`, "copilotApi.stop")
}

function setServerStopping(): void {
  status = "stopping"
  setStatus("Copilot API: Stopping...")
}

function getOutputChannel(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel("Copilot API")
  return outputChannel
}

function setStatus(text: string, command?: string) {
  statusItem ??= vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  )
  statusItem.text = text
  statusItem.command = command
  statusItem.show()
}

function getConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration("copilotApi")

  const port = cfg.get<number>("port", 4141)
  const verbose = cfg.get<boolean>("verbose", false)
  const accountType = cfg.get<ExtensionConfig["accountType"]>(
    "accountType",
    "individual",
  )
  const rateLimitSeconds = cfg.get<number | null>("rateLimitSeconds", null)
  const rateLimitWait = cfg.get<boolean>("rateLimitWait", false)
  const proxyEnv = cfg.get<boolean>("proxyEnv", false)
  const showToken = cfg.get<boolean>("showToken", false)

  return {
    port,
    verbose,
    accountType,
    rateLimitSeconds,
    rateLimitWait,
    proxyEnv,
    showToken,
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.unref()

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false)
        return
      }
      resolve(false)
    })

    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => {
        resolve(true)
      })
    })
  })
}

function cleanupWorker() {
  worker?.removeAllListeners()
  worker = undefined
}

async function stopServer(): Promise<void> {
  const output = getOutputChannel()
  const currentWorker = worker
  if (!currentWorker) {
    setServerStopped()
    return
  }

  if (getServerStatus() === "stopping") return
  setServerStopping()

  try {
    await currentWorker.terminate()
  } catch (error) {
    output.appendLine(`[stop] Failed to terminate worker: ${String(error)}`)
  } finally {
    if (worker === currentWorker) {
      cleanupWorker()
      setServerStopped()
    }
  }
}

async function startServer(): Promise<void> {
  const output = getOutputChannel()
  output.show(true)

  const currentStatus = getServerStatus()
  if (currentStatus === "starting" || currentStatus === "running") {
    void vscode.window.showInformationMessage(
      "Copilot API server is already running.",
    )
    return
  }

  const config = getConfig()
  if (!isValidPort(config.port)) {
    void vscode.window.showErrorMessage(
      `Invalid port: ${String(config.port)} (must be 1-65535).`,
    )
    return
  }

  if (!(await isPortAvailable(config.port))) {
    void vscode.window.showErrorMessage(
      `Port ${config.port} is already in use. Change "copilotApi.port" in settings.`,
    )
    return
  }

  setServerStarting()

  const currentWorker = createWorker(config)
  worker = currentWorker

  wireWorkerIO(currentWorker, output)
  wireWorkerEvents(currentWorker, output, config.port)

  void showStartingHintAfterDelay()
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

function createWorker(config: ExtensionConfig): Worker {
  const workerUrl = new URL("./server-worker.js", import.meta.url)

  return new Worker(workerUrl, {
    stdout: true,
    stderr: true,
    workerData: {
      port: config.port,
      verbose: config.verbose,
      accountType: config.accountType,
      rateLimitSeconds: config.rateLimitSeconds,
      rateLimitWait: config.rateLimitWait,
      proxyEnv: config.proxyEnv,
      showToken: config.showToken,
    },
  })
}

function wireWorkerIO(
  currentWorker: Worker,
  output: vscode.OutputChannel,
): void {
  currentWorker.stdout.on("data", (chunk: unknown) => {
    const raw = chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk)
    output.append(raw)
  })
  currentWorker.stderr.on("data", (chunk: unknown) => {
    const raw = chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk)
    output.append(raw)
  })
}

function wireWorkerEvents(
  currentWorker: Worker,
  output: vscode.OutputChannel,
  port: number,
): void {
  currentWorker.on("message", (msg: unknown) => {
    if (worker !== currentWorker) return

    const message = msg as Partial<WorkerMessage>
    if (message.type === "ready" && typeof message.endpoint === "string") {
      endpoint = message.endpoint
      setServerRunning(port)
      output.appendLine(`[server] Ready: ${endpoint}`)
      return
    }

    if (message.type === "starting" && typeof message.port === "number") {
      output.appendLine(`[server] Starting on port ${message.port}...`)
      return
    }

    if (message.type === "error" && typeof message.message === "string") {
      output.appendLine(`[server] Error: ${message.message}`)
      if (message.stack) output.appendLine(message.stack)
      void vscode.window.showErrorMessage(
        `Copilot API failed: ${message.message}`,
      )
      void stopServer()
    }
  })

  currentWorker.on("error", (error) => {
    if (worker !== currentWorker) return

    output.appendLine(`[worker] Error: ${String(error)}`)
    void vscode.window.showErrorMessage(
      "Copilot API worker crashed. See 'Copilot API' output for details.",
    )
    void stopServer()
  })

  currentWorker.on("exit", (code) => {
    if (worker !== currentWorker) return

    output.appendLine(`[worker] Exited with code ${code}`)
    cleanupWorker()
    setServerStopped()
  })
}

async function showStartingHintAfterDelay(): Promise<void> {
  await sleep(15_000)

  if (getServerStatus() === "starting") {
    setStatus("Copilot API: Starting... (see Output)")
  }
}

async function restartServer(): Promise<void> {
  await stopServer()
  await startServer()
}

async function copyEndpoint(): Promise<void> {
  if (!endpoint) {
    void vscode.window.showWarningMessage("Copilot API server is not running.")
    return
  }
  await vscode.env.clipboard.writeText(endpoint)
  void vscode.window.showInformationMessage(`Copied endpoint: ${endpoint}`)
}

async function openUsageViewer(): Promise<void> {
  if (!endpoint) {
    void vscode.window.showWarningMessage("Copilot API server is not running.")
    return
  }

  const usageUrl = `https://ericc-ch.github.io/copilot-api?endpoint=${encodeURIComponent(
    `${endpoint}/usage`,
  )}`

  await vscode.env.openExternal(vscode.Uri.parse(usageUrl))
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(getOutputChannel())

  setStatus("Copilot API: Stopped", "copilotApi.start")

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotApi.start", () => startServer()),
    vscode.commands.registerCommand("copilotApi.stop", () => stopServer()),
    vscode.commands.registerCommand("copilotApi.restart", () =>
      restartServer(),
    ),
    vscode.commands.registerCommand("copilotApi.copyEndpoint", () =>
      copyEndpoint(),
    ),
    vscode.commands.registerCommand("copilotApi.openUsageViewer", () =>
      openUsageViewer(),
    ),
  )
}

export async function deactivate() {
  await stopServer()
  outputChannel?.dispose()
  statusItem?.dispose()
}
