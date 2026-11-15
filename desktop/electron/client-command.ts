import { execFile, type ExecFileOptions } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getBunCandidates } from './bun-runtime'

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
      // npm's Windows .cmd shims need a shell. Resolve the package's bin and
      // invoke Node directly instead, keeping all arguments out of shell code.
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
    } catch {
      throw new Error('commandFailed')
    }
  }
  throw new Error('commandMissing')
}
