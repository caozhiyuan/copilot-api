import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { BunRuntimeStatus } from '../src/types/ipc'

const execFileAsync = promisify(execFile)

export function isSupportedBunVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 1 || (major === 1 && minor >= 4)
}

interface BunDetectionOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
  getVersion?: (executable: string) => Promise<string>
}

export function getBunCandidates({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
}: BunDetectionOptions = {}): string[] {
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const executable = windows ? 'bun.exe' : 'bun'
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  const directories = (env[pathKey ?? 'PATH'] ?? '')
    .split(windows ? ';' : ':')
    .map((directory) => directory.replace(/^"(.*)"$/, '$1'))
    .filter((directory) => paths.isAbsolute(directory))

  const candidates = directories.map((directory) =>
    paths.join(directory, executable),
  )
  if (env.BUN_INSTALL && paths.isAbsolute(env.BUN_INSTALL)) {
    candidates.push(paths.join(env.BUN_INSTALL, 'bin', executable))
  }
  candidates.push(paths.join(homeDir, '.bun', 'bin', executable))
  if (windows) {
    if (env.APPDATA) {
      candidates.push(
        paths.join(
          env.APPDATA,
          'npm',
          'node_modules',
          'bun',
          'bin',
          executable,
        ),
      )
    }
    if (env.LOCALAPPDATA) {
      candidates.push(
        paths.join(
          env.LOCALAPPDATA,
          'Microsoft',
          'WinGet',
          'Links',
          executable,
        ),
      )
    }
  } else {
    // Finder and desktop launchers often omit user-installed binaries from PATH.
    candidates.push(
      '/opt/homebrew/bin/bun',
      '/usr/local/bin/bun',
      '/usr/bin/bun',
    )
  }
  return [
    ...new Map(
      candidates.map((candidate) => [
        windows ? candidate.toLowerCase() : candidate,
        candidate,
      ]),
    ).values(),
  ]
}

async function readBunVersion(executable: string): Promise<string> {
  const { stdout } = await execFileAsync(executable, ['--version'], {
    timeout: 2000,
    killSignal: 'SIGKILL',
    windowsHide: true,
    maxBuffer: 1024,
  })
  return stdout.trim()
}

export async function detectBunRuntime(
  options: BunDetectionOptions = {},
): Promise<BunRuntimeStatus> {
  const getVersion = options.getVersion ?? readBunVersion
  let unsupported: BunRuntimeStatus | undefined
  for (const executable of getBunCandidates(options)) {
    try {
      const version = (await getVersion(executable)).trim()
      if (isSupportedBunVersion(version)) {
        return { available: true, version, path: executable }
      }
      unsupported ??= { available: false, version, path: executable }
    } catch {
      // Missing, inaccessible, or unresponsive candidates are not usable.
    }
  }
  return unsupported ?? { available: false }
}
