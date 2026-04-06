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

let opencodeVersionCache: string | undefined

const getGlobalNpmRoot = async (): Promise<string> => {
  const stdout = await execAsync("npm root -g")
  return stdout.trim()
}

async function resolveOpencodeVersion(): Promise<void> {
  try {
    const npmRootPath = await getGlobalNpmRoot()
    const opencodePackagePath = path.join(
      npmRootPath,
      "opencode-ai",
      "package.json",
    )
    const packageJson = await readFile(opencodePackagePath, "utf8")
    const { version } = JSON.parse(packageJson) as { version: string }
    opencodeVersionCache = version
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
