import consola from "consola"
import { exec } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"

const execAsync = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }

      resolve(stdout)
    })
  })
}

const OPENCODE_PACKAGE_NAMES = ["@opencode/cli", "opencode-ai"] as const

let opencodeVersionCache: string | undefined

const getGlobalNpmRoot = async (): Promise<string> => {
  const stdout = await execAsync("npm root -g")
  return stdout.trim()
}

const readPackageVersion = async (packageJsonPath: string): Promise<string> => {
  const packageJson = await readFile(packageJsonPath, "utf8")
  const parsedPackage: unknown = JSON.parse(packageJson)

  if (
    !parsedPackage
    || typeof parsedPackage !== "object"
    || !("version" in parsedPackage)
    || typeof parsedPackage.version !== "string"
  ) {
    throw new Error(`Invalid opencode package metadata: ${packageJsonPath}`)
  }

  const version = parsedPackage.version.trim()
  if (!version) {
    throw new Error(`Invalid opencode package version: ${packageJsonPath}`)
  }

  return version
}

export const resolveOpencodeVersionFromNpmRoot = async (
  npmRootPath: string,
): Promise<string> => {
  let lastError: unknown

  for (const packageName of OPENCODE_PACKAGE_NAMES) {
    try {
      return await readPackageVersion(
        path.join(npmRootPath, ...packageName.split("/"), "package.json"),
      )
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

async function resolveOpencodeVersion(): Promise<void> {
  try {
    const npmRootPath = await getGlobalNpmRoot()
    opencodeVersionCache = await resolveOpencodeVersionFromNpmRoot(npmRootPath)
  } catch (error) {
    consola.warn(`Failed to resolve opencode version`, error)
  }
}

export const initOpencodeVersion = (): Promise<void> => {
  if (process.env.COPILOT_API_OAUTH_APP?.trim() !== "opencode") {
    return Promise.resolve()
  }
  return resolveOpencodeVersion()
}

export const getCachedOpencodeVersion = (): string | undefined => {
  return opencodeVersionCache
}
