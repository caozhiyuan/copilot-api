import consola from "consola"
import { createHash, randomUUID } from "node:crypto"
import { networkInterfaces } from "node:os"

import { getVSCodeDeviceId } from "~/lib/providers/deviceid"
import { state } from "~/lib/state"
import { getVSCodeVersion } from "~/services/get-vscode-version"

export const cacheVSCodeVersion = async () => {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}

const invalidMacAddresses = new Set([
  "00:00:00:00:00:00",
  "ff:ff:ff:ff:ff:ff",
  "ac:de:48:00:11:22",
])

function validateMacAddress(candidate: string): boolean {
  const tempCandidate = candidate.replaceAll("-", ":").toLowerCase()
  return !invalidMacAddresses.has(tempCandidate)
}

export function getMac(): string | null {
  const ifaces = networkInterfaces()
  // eslint-disable-next-line guard-for-in
  for (const name in ifaces) {
    const networkInterface = ifaces[name]
    if (networkInterface) {
      for (const { mac } of networkInterface) {
        if (validateMacAddress(mac)) {
          return mac
        }
      }
    }
  }
  return null
}

export const cacheMacMachineId = () => {
  const macAddress = getMac() ?? randomUUID()
  state.macMachineId = createHash("sha256")
    .update(macAddress, "utf8")
    .digest("hex")
  consola.debug(`Using machine ID: ${state.macMachineId}`)
}

export const cacheVsCodeDeviceId = async () => {
  state.vsCodeDeviceId = await getVSCodeDeviceId()
  consola.debug(`Using VSCode device ID: ${state.vsCodeDeviceId}`)
}

const SESSION_REFRESH_BASE_MS = 60 * 60 * 1000
const SESSION_REFRESH_JITTER_MS = 20 * 60 * 1000
let vsCodeSessionRefreshTimer: ReturnType<typeof setTimeout> | null = null

const generateSessionId = () => {
  state.vsCodeSessionId = randomUUID() + Date.now().toString()
  consola.debug(`Generated VSCode session ID: ${state.vsCodeSessionId}`)
}

export const stopVsCodeSessionRefreshLoop = () => {
  if (vsCodeSessionRefreshTimer) {
    clearTimeout(vsCodeSessionRefreshTimer)
    vsCodeSessionRefreshTimer = null
  }
}

const scheduleSessionIdRefresh = () => {
  const randomDelay = Math.floor(Math.random() * SESSION_REFRESH_JITTER_MS)
  const delay = SESSION_REFRESH_BASE_MS + randomDelay
  consola.debug(
    `Scheduling next VSCode session ID refresh in ${Math.round(
      delay / 1000,
    )} seconds`,
  )

  stopVsCodeSessionRefreshLoop()
  vsCodeSessionRefreshTimer = setTimeout(() => {
    try {
      generateSessionId()
    } catch (error) {
      consola.error("Failed to refresh session ID, rescheduling...", error)
    } finally {
      scheduleSessionIdRefresh()
    }
  }, delay)
}

export const cacheVsCodeSessionId = () => {
  stopVsCodeSessionRefreshLoop()
  generateSessionId()
  scheduleSessionIdRefresh()
}
