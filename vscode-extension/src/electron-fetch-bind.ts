import type * as vscode from "vscode"

type ElectronModule = typeof import("electron")

export async function bindElectronNetFetchOnStartup(
  output: vscode.OutputChannel,
): Promise<void> {
  const runtimeElectronVersion = process.versions.electron
  output.append(
    `[copilot-api] electron runtime version: ${runtimeElectronVersion}\n`,
  )

  let electron: ElectronModule
  try {
    electron = (await import("electron")) as ElectronModule
  } catch (error: unknown) {
    output.append(
      `[copilot-api] import("electron") failed: ${error instanceof Error ? error.message + (error.stack ?? "") : String(error)}`,
    )
    return
  }

  const netFetch = (electron as unknown as { net?: { fetch?: unknown } }).net
    ?.fetch
  if (typeof netFetch !== "function") {
    output.append(`[copilot-api] electron.net.fetch not available.`)
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  globalThis.fetch = netFetch.bind(electron.net)

  output.append(
    `[copilot-api] electron.net.fetch assigned to globalThis.fetch.\n`,
  )
}
