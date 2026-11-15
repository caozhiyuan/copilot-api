import { execFile, type ExecFileOptions } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getBunCandidates } from './bun-runtime'
import type { ClientCommandFailure } from '../shared/client-integrations'

const exec = promisify(execFile)
export type ClientCommand = 'claude' | 'dsh'
export type ClientExec = (
  file: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>
const execute: ClientExec = (file, args, options) =>
  exec(file, args, { ...options, encoding: 'utf8' })
interface ClientCommandOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  platform?: NodeJS.Platform
  execute?: ClientExec
}

export class ClientCommandError extends Error {
  readonly details: ClientCommandFailure

  constructor(command: ClientCommand, args: string[], cause: unknown) {
    super('commandFailed')
    const code =
      cause && typeof cause === 'object' && 'code' in cause ?
        cause.code
      : undefined
    // CLI output can contain credentials. Expose only our command and a stable
    // process exit/error code, never stderr or the original error message.
    this.details = {
      command: [command, ...args]
        .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
        .join(' '),
      ...((
        (typeof code === 'number' && Number.isInteger(code))
        || (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))
      ) ?
        { exitCode: String(code) }
      : {}),
    }
  }
}

export async function runClientCommand(
  command: ClientCommand,
  args: string[],
  options: ClientCommandOptions = {},
) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.homeDir ?? os.homedir()
  const pathKey =
    Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const directories = [
    ...new Set([
      ...(env[pathKey] ?? '').split(path.delimiter),
      path.join(home, '.local', 'bin'),
      ...(await getBunCandidates({ env, platform, homeDir: home })).map(
        (candidate) => path.dirname(candidate),
      ),
    ]),
  ].filter((directory) => path.isAbsolute(directory))
  const packageName =
    command === 'claude' ? '@anthropic-ai/claude-code' : '@deepseek-ai/dsh'
  for (const directory of directories) {
    const executable = path.join(
      directory,
      `${command}${platform === 'win32' ? '.exe' : ''}`,
    )
    let invocation: { file: string; args: string[] } | undefined
    try {
      await fs.access(executable, fs.constants.X_OK)
      invocation = { file: executable, args }
    } catch {
      // Resolve npm's package bin without running its Windows .cmd shim.
      // Recent Claude packages contain a native executable; older ones use JS.
      const roots = [
        path.join(directory, 'node_modules'),
        path.resolve(directory, '../lib/node_modules'),
      ]
      for (const root of roots) {
        try {
          const packageRoot = path.join(root, packageName)
          const pkg = JSON.parse(
            await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
          ) as {
            bin?: string | Record<string, string>
          }
          const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[command]
          if (!bin) continue
          const script = path.resolve(packageRoot, bin)
          await fs.access(script)
          if (path.extname(script).toLowerCase() === '.exe') {
            invocation = { file: script, args }
            break
          }
          const node = path.join(
            directory,
            platform === 'win32' ? 'node.exe' : 'node',
          )
          const nodeExists = await fs.access(node).then(
            () => true,
            () => false,
          )
          invocation = {
            file: nodeExists ? node : 'node',
            args: [script, ...args],
          }
          break
        } catch {
          // Try the next npm layout or executable location.
        }
      }
    }
    if (!invocation) continue
    try {
      return await (options.execute ?? execute)(
        invocation.file,
        invocation.args,
        {
          windowsHide: true,
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
          env: {
            ...env,
            [pathKey]: [directory, ...directories].join(path.delimiter),
          },
        },
      )
    } catch (error) {
      throw new ClientCommandError(command, args, error)
    }
  }
  throw new Error('commandMissing')
}
