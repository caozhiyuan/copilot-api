import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClientExec } from './client-command'
import { loadWindowsEnvironmentNotifier } from './windows-environment'

const exec = promisify(execFile)
const execute: ClientExec = (file, args, options) =>
  exec(file, args, { ...options, encoding: 'utf8' })
export const CLIENT_KEY_ENV = 'GITHUB_COPILOT_API_KEY'
const START = '# >>> copilot-api client key >>>'
const END = '# <<< copilot-api client key <<<'
const WINDOWS_ENVIRONMENT_KEY = 'HKCU\\Environment'
const WINDOWS_VALUE_PATTERN = new RegExp(
  `^\\s*${CLIENT_KEY_ENV}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`,
  'm',
)

function windowsRegistryArgs(value: string | null): string[] {
  if (value === null)
    return ['delete', WINDOWS_ENVIRONMENT_KEY, '/v', CLIENT_KEY_ENV, '/f']
  return [
    'add',
    WINDOWS_ENVIRONMENT_KEY,
    '/v',
    CLIENT_KEY_ENV,
    '/t',
    'REG_SZ',
    '/d',
    value,
    '/f',
  ]
}

function windowsRegistryValue(stdout: string): string | null {
  return WINDOWS_VALUE_PATTERN.exec(stdout)?.[1].replace(/\r$/, '') || null
}

export function patchShellEnvironment(content: string, value: string): string {
  const block = `${START}\nexport ${CLIENT_KEY_ENV}='${value.replaceAll("'", "'\"'\"'")}'\n${END}`
  const start = content.indexOf(START)
  const end = content.indexOf(END)
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) throw new Error('invalidConfig')
    return content.slice(0, start) + block + content.slice(end + END.length)
  }
  return (
    content + (content.endsWith('\n') || !content ? '' : '\n') + block + '\n'
  )
}

export function macEnvironmentAgent(value: string): string {
  const escaped = value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.copilot-api.client-env</string>
<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>${CLIENT_KEY_ENV}</string><string>${escaped}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`
}

export async function readClientEnvironment(
  platform = process.platform,
  run = execute,
): Promise<string | null> {
  try {
    if (platform === 'win32') {
      const { stdout } = await run(
        'reg.exe',
        ['query', WINDOWS_ENVIRONMENT_KEY, '/v', CLIENT_KEY_ENV],
        { windowsHide: true, timeout: 10_000 },
      )
      return windowsRegistryValue(stdout)
    }
    if (platform === 'darwin') {
      const { stdout } = await run(
        '/bin/launchctl',
        ['getenv', CLIENT_KEY_ENV],
        { timeout: 10_000 },
      )
      return stdout.trim() || null
    }
    return process.env[CLIENT_KEY_ENV] ?? null
  } catch (error) {
    const code = (error as { code?: number | string }).code
    if ((platform === 'darwin' || platform === 'win32') && code === 1)
      return null
    throw new Error('environmentFailed')
  }
}

export async function writeClientEnvironment(
  value: string | null,
  platform = process.platform,
  run = execute,
  loadNotifier = loadWindowsEnvironmentNotifier,
): Promise<void> {
  let notify: Awaited<ReturnType<typeof loadNotifier>> | undefined
  try {
    if (platform === 'win32') {
      // Resolve the native binding before mutating persistent credentials.
      notify = await loadNotifier()
      try {
        await run('reg.exe', windowsRegistryArgs(value), {
          windowsHide: true,
          timeout: 10_000,
        })
      } catch (error) {
        const missing =
          value === null && (error as { code?: number | string }).code === 1
        if (!missing) throw error
      }
    } else if (platform === 'darwin') {
      await run(
        '/bin/launchctl',
        value === null ?
          ['unsetenv', CLIENT_KEY_ENV]
        : ['setenv', CLIENT_KEY_ENV, value],
        { timeout: 10_000 },
      )
    }
    if (value === null) delete process.env[CLIENT_KEY_ENV]
    else process.env[CLIENT_KEY_ENV] = value
  } catch {
    throw new Error('environmentFailed')
  }
  if (notify) {
    try {
      if (!(await notify()))
        console.warn(
          'Windows environment change notification timed out or failed.',
        )
    } catch {
      // Persistence already succeeded. A notification failure must not roll
      // client files back while leaving the new registry value in place.
      console.warn('Failed to notify Windows of the environment change.')
    }
  }
}
