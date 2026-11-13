import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { BunRuntimeStatus } from '../src/types/ipc'

const execFileAsync = promisify(execFile)

const MINIMUM_BUN_VERSION = [1, 4, 4] as const
const NODE_VERSION_DIRECTORY = /^v\d+\.\d+\.\d+$/
// proxy.exe prints this and exits before CreateProcess (stderr, one line).
const NVM_SHIM_VERSION_OUTPUT = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i
// Community preferences. Not an environment variable; v2 does not use NVM_HOME
// for this store. See nvm-windows/shim shared/config.zig.
const NVM_WINDOWS_PREFERENCE_KEY =
  'HKCU\\Software\\Author Software\\Preferences\\nvm'

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
  /** Exact Node version (`24.10.0` or `v24.10.0`) to try before newer installs. */
  activeNodeVersion?: string
  /**
   * Text from `reg query` of the nvm-windows 2 preference key.
   * Omit to query that key on Windows. An empty string skips the lookup.
   */
  nvmPreferenceQuery?: string
  /** Windows only. Defaults to `<candidate> --nvm-shim-version`. */
  isNvmShim?: (executable: string) => Promise<boolean>
}

function normalizeNodeVersionDirectory(
  version: string | undefined,
): string | undefined {
  const bare = version?.trim().replace(/^v/i, '') ?? ''
  if (!/^\d+\.\d+\.\d+$/.test(bare)) return undefined
  return `v${bare}`
}

function isNvmShimVersionOutput(stdout: string, stderr: string): boolean {
  // Bun 1.4.4 exits 0 and prints multi-line help for this unknown flag.
  // The nvm proxy prints only its own version.
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.length === 1 && NVM_SHIM_VERSION_OUTPUT.test(lines[0] ?? '')
}

function decodeRegistryQueryOutput(buffer: Buffer): string {
  const utf16 =
    (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0)
  const text = utf16 ? buffer.toString('utf16le') : buffer.toString('utf8')
  return text.replace(/^\uFEFF/, '')
}

function parseNvmWindowsPreferenceQuery(text: string): {
  activeVersion?: string
  installRoot?: string
} {
  const parsed: { activeVersion?: string; installRoot?: string } = {}
  const pattern =
    /^\s*(ActiveVersion|InstallRoot)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/gim
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.toLowerCase()
    const value = match[2]?.trim()
    if (!name || !value) continue
    if (name === 'activeversion') parsed.activeVersion ??= value
    else parsed.installRoot ??= value
  }
  return parsed
}

function expandWindowsEnv(
  value: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let unresolved = false
  const expanded = value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = Object.keys(env).find(
      (item) => item.toUpperCase() === name.toUpperCase(),
    )
    const replacement = key ? env[key] : undefined
    if (!replacement) {
      unresolved = true
      return ''
    }
    return replacement
  })
  const trimmed = expanded.trim()
  if (unresolved || !trimmed) return undefined
  return trimmed
}

function readNvmWindowsPreferenceQuery(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', NVM_WINDOWS_PREFERENCE_KEY],
      {
        encoding: 'buffer',
        timeout: 2000,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(undefined)
          return
        }
        const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
        resolve(decodeRegistryQueryOutput(buffer))
      },
    )
  })
}

/** True when `executable` is nvm-windows' proxy shim rather than Bun. */
export async function isNvmWindowsShim(executable: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(
      executable,
      ['--nvm-shim-version'],
      {
        timeout: 2000,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 32 * 1024,
      },
    )
    return isNvmShimVersionOutput(stdout, stderr)
  } catch {
    // Missing binaries and real Bun (non-zero, or help text) are not shims.
    return false
  }
}

function isNvmWindowsShimDirectory(directory: string): boolean {
  const paths = path.win32
  if (paths.basename(directory).toLowerCase() !== '.shim') return false
  // {DataRoot}\.shim, and DataRoot is the program directory named nvm.
  return paths.basename(paths.dirname(directory)).toLowerCase() === 'nvm'
}

function windowsNvmProgramRoots(
  env: NodeJS.ProcessEnv,
  paths: typeof path.win32,
  homeDir: string,
): Array<string | undefined> {
  const localAppData =
    env.LOCALAPPDATA ?? paths.join(homeDir, 'AppData', 'Local')
  const roots: Array<string | undefined> = [
    env.NVM_HOME,
    paths.join(env.APPDATA ?? paths.join(homeDir, 'AppData', 'Roaming'), 'nvm'),
    paths.join(localAppData, 'nvm'),
    // v2 community program root is fixed. Versions live in installs\vX.Y.Z.
    paths.join(localAppData, 'Author Software', 'nvm'),
  ]
  for (const programFiles of [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432,
  ]) {
    if (programFiles) {
      roots.push(paths.join(programFiles, 'Author Software', 'nvm'))
    }
  }
  return roots
}

async function appendVersionDirectories(
  versionsRoot: string,
  paths: path.PlatformPath,
  windows: boolean,
  readDirectory: (directory: string) => Promise<string[]>,
  activeVersion: string | undefined,
  preferred: string[],
  rest: string[],
): Promise<void> {
  let entries: string[]
  try {
    entries = await readDirectory(versionsRoot)
  } catch {
    // A missing or inaccessible nvm installation must not prevent fallback.
    return
  }
  const versions = entries
    .filter((version) => NODE_VERSION_DIRECTORY.test(version))
    .sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    )
  for (const version of versions) {
    const prefix = paths.join(versionsRoot, version)
    const bin = windows ? prefix : paths.join(prefix, 'bin')
    if (
      activeVersion
      && version.toLowerCase() === activeVersion.toLowerCase()
    ) {
      preferred.push(bin)
    } else rest.push(bin)
  }
}

async function getNvmBinDirectories({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  readDirectory = readdir,
  activeNodeVersion,
  installRoots = [],
}: BunDetectionOptions & { installRoots?: string[] }): Promise<string[]> {
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const activeVersion = normalizeNodeVersionDirectory(activeNodeVersion)
  const preferred: string[] = []
  const rest: string[] = []
  const seen = new Set<string>()
  const scan = async (versionsRoot: string | undefined) => {
    if (!versionsRoot || !paths.isAbsolute(versionsRoot)) return
    const key = windows ? versionsRoot.toLowerCase() : versionsRoot
    if (seen.has(key)) return
    seen.add(key)
    await appendVersionDirectories(
      versionsRoot,
      paths,
      windows,
      readDirectory,
      activeVersion,
      preferred,
      rest,
    )
  }

  if (windows) {
    // Registry InstallRoot is the versions directory itself (default
    // %LOCALAPPDATA%\Author Software\nvm\installs), not the program root.
    for (const installRoot of installRoots) await scan(installRoot)
    for (const root of windowsNvmProgramRoots(env, paths, homeDir)) {
      if (!root || !paths.isAbsolute(root)) continue
      // v1 keeps vX.Y.Z directly under NVM_HOME. v2 uses root\installs.
      await scan(root)
      await scan(paths.join(root, 'installs'))
    }
  } else {
    const roots = [
      env.NVM_DIR,
      env.XDG_CONFIG_HOME && paths.join(env.XDG_CONFIG_HOME, 'nvm'),
      paths.join(homeDir, '.nvm'),
      paths.join(homeDir, '.config', 'nvm'),
    ]
    for (const root of roots) {
      if (!root || !paths.isAbsolute(root)) continue
      await scan(paths.join(root, 'versions', 'node'))
    }
  }
  return [...preferred, ...rest]
}

export async function getBunCandidates(
  options: BunDetectionOptions = {},
): Promise<string[]> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const readDirectory = options.readDirectory ?? readdir
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const executable = windows ? 'bun.exe' : 'bun'
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  const directories = (env[pathKey ?? 'PATH'] ?? '')
    .split(windows ? ';' : ':')
    .map((directory) => directory.replace(/^"(.*)"$/, '$1'))
    .filter((directory) => paths.isAbsolute(directory))

  const preferenceQuery =
    options.nvmPreferenceQuery !== undefined ? options.nvmPreferenceQuery
    : windows && options.env === undefined && process.platform === 'win32' ?
      await readNvmWindowsPreferenceQuery()
    : undefined
  const preferences =
    preferenceQuery ? parseNvmWindowsPreferenceQuery(preferenceQuery) : {}
  const configuredInstallRoot =
    preferences.installRoot ?
      expandWindowsEnv(preferences.installRoot, env)
    : undefined

  const candidates: string[] = []
  const addBinDirectory = (directory: string | undefined) => {
    if (!directory || !paths.isAbsolute(directory)) return
    // {DataRoot}\.shim\bun.exe is proxy.exe. Running it makes the real bun a
    // grandchild, outside Electron's job object.
    if (windows && isNvmWindowsShimDirectory(directory)) return
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
    activeNodeVersion: options.activeNodeVersion ?? preferences.activeVersion,
    installRoots: configuredInstallRoot ? [configuredInstallRoot] : [],
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
  const platform = options.platform ?? process.platform
  const getVersion = options.getVersion ?? readBunVersion
  const isNvmShim =
    platform === 'win32' ?
      (options.isNvmShim ?? isNvmWindowsShim)
    : () => Promise.resolve(false)
  let unsupported: BunRuntimeStatus | undefined
  for (const executable of await getBunCandidates(options)) {
    try {
      if (await isNvmShim(executable)) continue
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
