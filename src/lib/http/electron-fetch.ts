import consola from "consola"
import { createRequire } from "node:module"

type ElectronModule = {
  net?: {
    fetch?: typeof fetch
  }
}

const require = createRequire(import.meta.url)

export function bindElectronFetch(): boolean {
  if (!process.versions.electron) return false

  try {
    const electronModule = require("electron") as ElectronModule
    const netFetch = electronModule.net?.fetch

    if (typeof netFetch !== "function") return false

    globalThis.fetch = netFetch.bind(electronModule.net)
    consola.log("Successfully bound Electron's net.fetch to global fetch.")
    return true
  } catch {
    consola.log(
      "Failed to bind Electron's net.fetch. Falling back to global fetch.",
    )
    return false
  }
}
