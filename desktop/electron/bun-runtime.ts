import { execFile } from 'node:child_process'
import { readdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { BunRuntimeStatus } from '../src/types/ipc'

const execFileAsync = promisify(execFile)

const MINIMUM_BUN_VERSION = [1, 4, 4] as const
const NVM2_REGISTRY_KEYS = [
  'HKCU\\SOFTWARE\\Author Software\\Preferences\\nvm',
  'HKLM\\SOFTWARE\\Policies\\Author Software\\nvm',
] as const
const NVM2_INSTALL_ROOT_VALUE = 'InstallRoot'

export function isSupportedBunVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(version.trim())
  if (!match) return false
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])]
  for (const [index, minimum] of MINIMUM_BUN_VERSION.entries()) {
    const part = parts[index] ?? 0
    if (part > minimum) return true
    if (part < minimum) return false
  }
  return true
}

interface BunDetectionOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homeDir?: string
  getVersion?: (executable: string) => Promise<string>
  readDirectory?: (directory: string) => Promise<string[]>
  resolveDirectory?: (directory: string) => Promise<string>
  readRegistryValue?: (key: string, name: string) => Promise<string | null>
}

export function parseWindowsRegistryValue(
  stdout: string,
  name: string,
): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(
    `^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`,
    'im',
  ).exec(stdout)
  const raw = match?.[1]?.replace(/\r$/, '').trim()
  return raw ? raw.replace(/^"(.*)"$/, '$1') : null
}

async function readWindowsRegistryValue(
  key: string,
  name: string,
): Promise<string | null> {
  const { stdout } = await execFileAsync(
    'reg.exe',
    ['query', key, '/v', name],
    {
      timeout: 2000,
      killSignal: 'SIGKILL',
      windowsHide: true,
      maxBuffer: 8192,
    },
  )
  return parseWindowsRegistryValue(stdout, name)
}

function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  if (!value.includes('%')) return value
  const lookup = new Map<string, string>()
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === 'string') lookup.set(key.toUpperCase(), val)
  }
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    return lookup.get(name.toUpperCase()) ?? match
  })
}

async function getNvm2ConfiguredInstallRoots(
  env: NodeJS.ProcessEnv,
  readRegistryValue?: (key: string, name: string) => Promise<string | null>,
): Promise<string[]> {
  const reader =
    readRegistryValue
    ?? (process.platform === 'win32' && env === process.env ?
      readWindowsRegistryValue
    : undefined)
  if (!reader) return []

  const roots: string[] = []
  for (const key of NVM2_REGISTRY_KEYS) {
    try {
      const raw = await reader(key, NVM2_INSTALL_ROOT_VALUE)
      if (!raw) continue
      const expanded = expandWindowsEnvVars(raw.trim(), env).replace(
        /^"(.*)"$/,
        '$1',
      )
      if (path.win32.isAbsolute(expanded)) {
        roots.push(expanded)
      }
    } catch {
      // Missing registry keys or inaccessible reg.exe must not prevent fallback.
    }
  }
  return roots
}

async function getNvmBinDirectories({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  readDirectory = readdir,
  readRegistryValue,
}: BunDetectionOptions): Promise<string[]> {
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const configuredInstallRoots =
    windows ? await getNvm2ConfiguredInstallRoots(env, readRegistryValue) : []
  const roots =
    windows ?
      [
        env.NVM_HOME,
        env.NVM_HOME && paths.isAbsolute(env.NVM_HOME) ?
          paths.join(env.NVM_HOME, 'installs')
        : undefined,
        ...configuredInstallRoots,
        paths.join(
          env.APPDATA ?? paths.join(homeDir, 'AppData', 'Roaming'),
          'nvm',
        ),
        paths.join(
          env.LOCALAPPDATA ?? paths.join(homeDir, 'AppData', 'Local'),
          'nvm',
        ),
        // nvm-windows 2 stores Node versions below this location by default.
        paths.join(
          env.LOCALAPPDATA ?? paths.join(homeDir, 'AppData', 'Local'),
          'Author Software',
          'nvm',
          'installs',
        ),
      ]
    : [
        env.NVM_DIR,
        env.XDG_CONFIG_HOME && paths.join(env.XDG_CONFIG_HOME, 'nvm'),
        paths.join(homeDir, '.nvm'),
        paths.join(homeDir, '.config', 'nvm'),
      ]
  const uniqueRoots = [
    ...new Map(
      roots
        .filter((root): root is string =>
          Boolean(root && paths.isAbsolute(root)),
        )
        .map((root) => [windows ? root.toLowerCase() : root, root]),
    ).values(),
  ]
  const directories: string[] = []
  for (const root of uniqueRoots) {
    const versionsRoot = windows ? root : paths.join(root, 'versions', 'node')
    try {
      // GUI launches need not inherit nvm's shell initialization or active PATH.
      const versions = (await readDirectory(versionsRoot))
        .filter((version) => /^v\d+\.\d+\.\d+$/.test(version))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const version of versions) {
        const prefix = paths.join(versionsRoot, version)
        directories.push(windows ? prefix : paths.join(prefix, 'bin'))
      }
    } catch {
      // A missing or inaccessible nvm installation must not prevent fallback.
    }
  }
  return directories
}

export async function getBunCandidates({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  readDirectory,
  readRegistryValue,
}: BunDetectionOptions = {}): Promise<string[]> {
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const executable = windows ? 'bun.exe' : 'bun'
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  const directories = (env[pathKey ?? 'PATH'] ?? '')
    .split(windows ? ';' : ':')
    .map((directory) => directory.replace(/^"(.*)"$/, '$1'))
    .filter((directory) => paths.isAbsolute(directory))

  const candidates: string[] = []
  const addBinDirectory = (directory: string | undefined) => {
    if (!directory || !paths.isAbsolute(directory)) return
    // nvm-windows 2's .shim/bun.exe is a proxy that starts Bun as a grandchild.
    if (
      windows
      && paths.basename(directory).toLowerCase() === '.shim'
      && paths.basename(paths.dirname(directory)).toLowerCase() === 'nvm'
    )
      return
    candidates.push(paths.join(directory, executable))
    if (windows) {
      // npm exposes bun.cmd here; execFile/spawn need the package's native exe.
      candidates.push(
        paths.join(directory, 'node_modules', 'bun', 'bin', 'bun.exe'),
      )
    }
  }
  directories.forEach(addBinDirectory)
  addBinDirectory(env.NVM_BIN)
  if (windows) addBinDirectory(env.NVM_SYMLINK)
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX
  if (npmPrefix && paths.isAbsolute(npmPrefix)) {
    addBinDirectory(windows ? npmPrefix : paths.join(npmPrefix, 'bin'))
  }
  if (env.BUN_INSTALL && paths.isAbsolute(env.BUN_INSTALL)) {
    candidates.push(paths.join(env.BUN_INSTALL, 'bin', executable))
  }
  candidates.push(paths.join(homeDir, '.bun', 'bin', executable))
  if (windows) {
    if (env.APPDATA) {
      addBinDirectory(paths.join(env.APPDATA, 'npm'))
    }
    if (env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA)) {
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
  const nvmDirectories = await getNvmBinDirectories({
    env,
    platform,
    homeDir,
    readDirectory,
    readRegistryValue,
  })
  nvmDirectories.forEach(addBinDirectory)
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
  const resolveDirectory = options.resolveDirectory ?? realpath
  const windows = (options.platform ?? process.platform) === 'win32'
  let unsupported: BunRuntimeStatus | undefined
  for (const executable of await getBunCandidates(options)) {
    try {
      // In NVM's shim mode, .nodejs exposes the same proxy as .shim.
      if (windows && executable.toLowerCase().endsWith('\\.nodejs\\bun.exe')) {
        const target = await resolveDirectory(path.win32.dirname(executable))
        if (path.win32.basename(target).toLowerCase() === '.shim') continue
      }
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
