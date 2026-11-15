import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClientExec } from './client-command'

const exec = promisify(execFile)
const execute: ClientExec = (file, args, options) =>
  exec(file, args, { ...options, encoding: 'utf8' })
export const CLIENT_KEY_ENV = 'GITHUB_COPILOT_API_KEY'
const START = '# >>> copilot-api client key >>>'
const END = '# <<< copilot-api client key <<<'

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
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Environment]::GetEnvironmentVariable('${CLIENT_KEY_ENV}', 'User')`,
        ],
        { windowsHide: true, timeout: 10_000 },
      )
      return stdout.trim() || null
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
    if (
      platform === 'darwin'
      && (error as { code?: number | string }).code === 1
    )
      return null
    throw new Error('environmentFailed')
  }
}

export async function writeClientEnvironment(
  value: string | null,
  platform = process.platform,
  run = execute,
): Promise<void> {
  try {
    if (platform === 'win32') {
      await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[Environment]::SetEnvironmentVariable('${CLIENT_KEY_ENV}', $env:COPILOT_API_SETUP_KEY, 'User')`,
        ],
        {
          windowsHide: true,
          timeout: 10_000,
          env: { ...process.env, COPILOT_API_SETUP_KEY: value ?? '' },
        },
      )
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
}
