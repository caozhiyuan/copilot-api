import consola from "consola"
import { randomUUID } from "node:crypto"
import path from "node:path"

const WINDOWS_DEVICE_ID_KEY = String.raw`\SOFTWARE\Microsoft\DeveloperTools`
const WINDOWS_DEVICE_ID_NAME = "deviceid"

type RegistryArch = "x86" | "x64"

interface WinregConstructor {
  new (options: {
    hive: string
    key: string
    arch?: RegistryArch
  }): WinregRegistry
  HKCU: string
  REG_SZ: string
}

interface WinregRegistry {
  get(
    name: string,
    callback: (error: RegistryError | null, item: RegistryItem | null) => void,
  ): void
  set(
    name: string,
    type: string,
    value: string,
    callback: (error: RegistryError | null) => void,
  ): void
}

interface RegistryItem {
  value?: string
}

interface RegistryError extends Error {
  code?: number | string
}

const windows64Architectures = new Set(["AMD64", "ARM64", "IA64"])

const getPosixHomeDir = (): string => {
  if (!process.env.HOME) {
    throw new Error("Home directory not found")
  }

  return process.env.HOME
}

const getDeviceIdFilePath = (): string => {
  let folder: string

  switch (process.platform) {
    case "darwin": {
      folder = path.posix.join(
        getPosixHomeDir(),
        "Library",
        "Application Support",
      )
      break
    }
    case "linux": {
      folder =
        process.env.XDG_CACHE_HOME
        ?? path.posix.join(getPosixHomeDir(), ".cache")
      break
    }
    default: {
      throw new Error("Unsupported platform")
    }
  }

  return path.posix.join(folder, "Microsoft", "DeveloperTools", "deviceid")
}

const isMissingFileError = (error: unknown): error is NodeJS.ErrnoException => {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

const readStoredDeviceIdFile = async (
  filePath: string,
): Promise<string | undefined> => {
  const { readFile } = await import("node:fs/promises")

  try {
    return await readFile(filePath, "utf8")
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }

    throw error
  }
}

const writeStoredDeviceIdFile = async (
  filePath: string,
  deviceId: string,
): Promise<void> => {
  const { mkdir, writeFile } = await import("node:fs/promises")

  await mkdir(path.posix.dirname(filePath), { recursive: true })
  await writeFile(filePath, deviceId, "utf8")
}

const getWindowsRegistryArch = (): RegistryArch | undefined => {
  const architecture = (
    process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE
  )?.toUpperCase()

  return architecture && windows64Architectures.has(architecture) ?
      "x64"
    : undefined
}

const loadWinreg = async (): Promise<WinregConstructor> => {
  const module = await import("winreg")
  const winreg =
    "default" in module ? (module.default as unknown) : (module as unknown)

  return winreg as WinregConstructor
}

const isMissingRegistryError = (error: RegistryError | null): boolean => {
  if (!error) {
    return false
  }

  const errorCode = Number(error.code)

  return Number.isFinite(errorCode) && errorCode === 1
}

const createWindowsRegistry = async (): Promise<{
  registry: WinregRegistry
  regSz: string
}> => {
  const Winreg = await loadWinreg()

  return {
    registry: new Winreg({
      hive: Winreg.HKCU,
      key: WINDOWS_DEVICE_ID_KEY,
      arch: getWindowsRegistryArch(),
    }),
    regSz: Winreg.REG_SZ,
  }
}

const readRegistryString = async (
  registry: WinregRegistry,
  name: string,
): Promise<string | undefined> => {
  return new Promise((resolve, reject) => {
    registry.get(name, (error, item) => {
      if (isMissingRegistryError(error)) {
        resolve(undefined)
        return
      }

      if (error) {
        reject(
          error instanceof Error ? error : new Error("Unknown registry error"),
        )
        return
      }

      resolve(item?.value)
    })
  })
}

const writeRegistryString = async ({
  registry,
  regSz,
  name,
  value,
}: {
  registry: WinregRegistry
  regSz: string
  name: string
  value: string
}): Promise<void> => {
  return new Promise((resolve, reject) => {
    registry.set(name, regSz, value, (error) => {
      if (error) {
        reject(
          error instanceof Error ? error : new Error("Unknown registry error"),
        )
        return
      }

      resolve()
    })
  })
}

export const getStoredVSCodeDeviceId = async (): Promise<
  string | undefined
> => {
  switch (process.platform) {
    case "win32": {
      const { registry } = await createWindowsRegistry()

      return readRegistryString(registry, WINDOWS_DEVICE_ID_NAME)
    }
    case "darwin":
    case "linux": {
      return readStoredDeviceIdFile(getDeviceIdFilePath())
    }
    default: {
      throw new Error("Unsupported platform")
    }
  }
}

const setStoredVSCodeDeviceId = async (deviceId: string): Promise<void> => {
  switch (process.platform) {
    case "win32": {
      const { registry, regSz } = await createWindowsRegistry()

      await writeRegistryString({
        registry,
        regSz,
        name: WINDOWS_DEVICE_ID_NAME,
        value: deviceId,
      })
      return
    }
    case "darwin":
    case "linux": {
      await writeStoredDeviceIdFile(getDeviceIdFilePath(), deviceId)
      return
    }
    default: {
      throw new Error("Unsupported platform")
    }
  }
}

const createVSCodeDeviceId = (): string => randomUUID().toLowerCase()

export async function getVSCodeDeviceId(): Promise<string> {
  let deviceId: string | undefined

  try {
    deviceId = await getStoredVSCodeDeviceId()
  } catch (error) {
    consola.debug("Failed to read VSCode device id", error)
  }

  if (deviceId) {
    return deviceId
  }

  const newDeviceId = createVSCodeDeviceId()

  await setStoredVSCodeDeviceId(newDeviceId)

  return newDeviceId
}
