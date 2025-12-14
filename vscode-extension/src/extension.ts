import type { Server } from "srvx"

import consola, { type ConsolaReporter } from "consola"
import * as net from "node:net"
import * as vscode from "vscode"

import { createVscodeOutputReporter } from "./consola-vscode-reporter"
import { bindElectronNetFetchOnStartup } from "./electron-fetch-bind"
import { sleep } from "./util"

type ServerStatus = "stopped" | "starting" | "running" | "stopping"

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
let localServer: Server | undefined
let endpoint: string | undefined
let consolaReporter: ConsolaReporter | undefined
let lifecycleVersion = 0

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

function cleanupLocalServer() {
  localServer = undefined
}

function cleanupConsolaReporter() {
  if (!consolaReporter) return
  consola.removeReporter(consolaReporter)
  consolaReporter = undefined
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

async function stopServer(): Promise<void> {
  const output = getOutputChannel()
  lifecycleVersion += 1

  const currentLocalServer = localServer

  if (!currentLocalServer) {
    cleanupConsolaReporter()
    setServerStopped()
    return
  }

  if (getServerStatus() === "stopping") return
  setServerStopping()

  try {
    await currentLocalServer.close(true)
  } catch (error) {
    output.appendLine(`[stop] Failed to close server: ${String(error)}`)
  } finally {
    if (localServer === currentLocalServer) cleanupLocalServer()
    cleanupConsolaReporter()
    setServerStopped()
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
      `Invalid port: ${config.port} (must be 1-65535).`,
    )
    return
  }

  if (!config.proxyEnv) {
    await bindElectronNetFetchOnStartup(output)
  }

  if (!(await isPortAvailable(config.port))) {
    void vscode.window.showErrorMessage(
      `Port ${config.port} is already in use. Change "copilotApi.port" in settings.`,
    )
    return
  }

  setServerStarting()
  const currentLifecycleVersion = (lifecycleVersion += 1)

  void showStartingHintAfterDelay()
  try {
    consolaReporter = createVscodeOutputReporter(output)
    consola.addReporter(consolaReporter)

    process.env.HOST = "127.0.0.1"
    process.env.NODE_ENV ??= "production"

    const { startServer: startCopilotServer } = await import("../../src/start")
    const currentServer = await startCopilotServer({
      port: config.port,
      verbose: config.verbose,
      accountType: config.accountType,
      manual: false,
      rateLimit: config.rateLimitSeconds ?? undefined,
      rateLimitWait: config.rateLimitWait,
      githubToken: undefined,
      claudeCode: false,
      showToken: config.showToken,
      proxyEnv: config.proxyEnv,
    })

    if (currentLifecycleVersion !== lifecycleVersion) {
      await currentServer.close(true)
      cleanupConsolaReporter()
      return
    }

    localServer = currentServer
    endpoint = `http://localhost:${config.port}`
    setServerRunning(config.port)
    output.appendLine(`[server] Ready: ${endpoint}`)
  } catch (error) {
    const { message, stack } = serializeError(error)
    output.appendLine(`[server] Error: ${message}`)
    if (stack) output.appendLine(stack)
    cleanupConsolaReporter()
    cleanupLocalServer()
    setServerStopped()
    void vscode.window.showErrorMessage(`Copilot API failed: ${message}`)
  }
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

async function showStartingHintAfterDelay(): Promise<void> {
  await sleep(10_000)

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
