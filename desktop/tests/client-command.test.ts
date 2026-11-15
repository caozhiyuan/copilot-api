import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ClientCommandError,
  runClientCommand,
  type ClientExec,
} from '../electron/client-command'
import {
  CLIENT_KEY_ENV,
  macEnvironmentAgent,
  patchShellEnvironment,
  readClientEnvironment,
  writeClientEnvironment,
} from '../electron/client-environment'

let directory: string
let execute: ReturnType<typeof mock<ClientExec>>
type LoadNotifier = NonNullable<Parameters<typeof writeClientEnvironment>[3]>
let loadNotifier: ReturnType<typeof mock<LoadNotifier>>
let notify: ReturnType<typeof mock<Awaited<ReturnType<LoadNotifier>>>>
const originalEnvironment = process.env[CLIENT_KEY_ENV]
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'client-command-'))
  execute = mock(() => Promise.resolve({ stdout: 'done', stderr: '' }))
  notify = mock(() => Promise.resolve(true))
  loadNotifier = mock(() => Promise.resolve(notify))
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
  if (originalEnvironment === undefined) delete process.env[CLIENT_KEY_ENV]
  else process.env[CLIENT_KEY_ENV] = originalEnvironment
})
function persist(file: string, content: string, mode = 0o600) {
  const destination = path.join(directory, file)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, content, { mode })
}
function commandOptions() {
  return {
    homeDir: directory,
    platform: 'linux' as const,
    env: { PATH: path.join(directory, 'bin') },
    execute,
  }
}
function windowsRegistryValue(value: string, type = 'REG_SZ') {
  return `\r\nHKEY_CURRENT_USER\\Environment\r\n    ${CLIENT_KEY_ENV}    ${type}    ${value}\r\n`
}

test('runs a native client executable with argument arrays and an augmented PATH', async () => {
  persist('bin/claude', '#!/bin/sh\n', 0o700)
  await runClientCommand(
    'claude',
    ['plugin', 'install', 'agent-inject@copilot-api-marketplace'],
    commandOptions(),
  )
  expect(execute.mock.calls[0][0]).toBe(path.join(directory, 'bin/claude'))
  expect(execute.mock.calls[0][1]).toEqual([
    'plugin',
    'install',
    'agent-inject@copilot-api-marketplace',
  ])
  expect(execute.mock.calls[0][2]).toMatchObject({
    windowsHide: true,
    timeout: 120000,
  })
  execute.mockRejectedValueOnce(new Error('private CLI stderr'))
  await expect(
    runClientCommand('claude', ['plugin'], commandOptions()),
  ).rejects.toThrow('commandFailed')
})
test('resolves npm JS bins without a shell, including sibling Node and lib/node_modules', async () => {
  persist(
    'bin/node_modules/@deepseek-ai/dsh/package.json',
    '{"bin":{"dsh":"cli.js"}}',
  )
  persist('bin/node_modules/@deepseek-ai/dsh/cli.js', '// cli')
  persist('bin/node', '#!/bin/sh\n', 0o700)
  await runClientCommand(
    'dsh',
    ['plugin', '--profile', 'desktop', 'add', 'dsh-copilot-api'],
    commandOptions(),
  )
  expect(execute.mock.calls[0][0]).toBe(path.join(directory, 'bin/node'))
  expect(execute.mock.calls[0][1][0]).toEndWith(
    path.join('@deepseek-ai', 'dsh', 'cli.js'),
  )
  fs.rmSync(path.join(directory, 'bin/node_modules'), { recursive: true })
  fs.rmSync(path.join(directory, 'bin/node'))
  persist(
    'lib/node_modules/@anthropic-ai/claude-code/package.json',
    '{"bin":"cli.js"}',
  )
  persist('lib/node_modules/@anthropic-ai/claude-code/cli.js', '// cli')
  await runClientCommand('claude', ['plugin'], commandOptions())
  expect(execute.mock.calls[1][0]).toBe('node')
})
test('handles missing client commands and incomplete npm installations', async () => {
  persist(
    'bin/node_modules/@deepseek-ai/dsh/package.json',
    '{"name":"incomplete"}',
  )
  await expect(runClientCommand('dsh', [], commandOptions())).rejects.toThrow(
    'commandMissing',
  )
  expect(execute).not.toHaveBeenCalled()
})
test('runs native npm package bins directly on Windows instead of passing them to Node', async () => {
  persist(
    'bin/node_modules/@anthropic-ai/claude-code/package.json',
    '{"bin":{"claude":"bin/claude.exe"}}',
  )
  persist(
    'bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    'MZ',
    0o700,
  )
  persist('bin/node.exe', 'MZ', 0o700)
  const args = ['plugin', 'list', '--json']
  await runClientCommand('claude', args, {
    ...commandOptions(),
    platform: 'win32',
  })
  expect(execute.mock.calls[0][0]).toBe(
    path.join(
      directory,
      'bin/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    ),
  )
  expect(execute.mock.calls[0][1]).toEqual(args)
})
test('includes safe command diagnostics without forwarding CLI messages or output', async () => {
  persist('bin/claude', '#!/bin/sh\n', 0o700)
  execute.mockRejectedValueOnce(
    Object.assign(new Error('private token'), {
      code: 1,
      stderr: 'private token',
      stdout: 'private configuration',
    }),
  )
  const error = await runClientCommand(
    'claude',
    ['plugin', 'marketplace', 'add', '/local/path with spaces'],
    commandOptions(),
  ).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(ClientCommandError)
  expect((error as ClientCommandError).details).toEqual({
    command: 'claude plugin marketplace add "/local/path with spaces"',
    exitCode: '1',
  })
  expect(JSON.stringify(error)).not.toContain('private')
  expect(
    new ClientCommandError('claude', [], { code: 'ENOENT' }).details.exitCode,
  ).toBe('ENOENT')
  expect(
    new ClientCommandError('claude', [], { code: 'private token' }).details
      .exitCode,
  ).toBeUndefined()
  expect(
    new ClientCommandError('claude', [], null).details.exitCode,
  ).toBeUndefined()
})
test('reads and writes Windows user environment values through reg.exe and broadcasts native notifications', async () => {
  const value = 'key-with-"$()&-characters'
  await writeClientEnvironment(value, 'win32', execute, loadNotifier)
  const [file, args, options] = execute.mock.calls[0]
  expect(file).toBe('reg.exe')
  expect(args).toEqual([
    'add',
    'HKCU\\Environment',
    '/v',
    CLIENT_KEY_ENV,
    '/t',
    'REG_SZ',
    '/d',
    value,
    '/f',
  ])
  expect(options).toMatchObject({ windowsHide: true, timeout: 10_000 })
  expect(process.env[CLIENT_KEY_ENV]).toBe(value)
  expect(notify).toHaveBeenCalledTimes(1)
  execute.mockResolvedValueOnce({
    stdout: windowsRegistryValue(value),
    stderr: '',
  })
  expect(await readClientEnvironment('win32', execute)).toBe(value)
  const [readFile, readArgs] = execute.mock.calls[1]
  expect(readFile).toBe('reg.exe')
  expect(readArgs).toEqual(['query', 'HKCU\\Environment', '/v', CLIENT_KEY_ENV])
  execute.mockResolvedValueOnce({
    stdout: windowsRegistryValue('expanded-%VALUE%', 'REG_EXPAND_SZ'),
    stderr: '',
  })
  expect(await readClientEnvironment('win32', execute)).toBe('expanded-%VALUE%')
  execute.mockResolvedValueOnce({
    stdout: windowsRegistryValue(''),
    stderr: '',
  })
  expect(await readClientEnvironment('win32', execute)).toBeNull()
  execute.mockRejectedValueOnce(
    Object.assign(new Error('missing'), { code: 1 }),
  )
  expect(await readClientEnvironment('win32', execute)).toBeNull()
  execute.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 5 }))
  await expect(readClientEnvironment('win32', execute)).rejects.toThrow(
    'environmentFailed',
  )
  expect(loadNotifier).toHaveBeenCalledTimes(1)
  await writeClientEnvironment(null, 'win32', execute, loadNotifier)
  expect(execute.mock.calls.at(-1)?.[1]).toEqual([
    'delete',
    'HKCU\\Environment',
    '/v',
    CLIENT_KEY_ENV,
    '/f',
  ])
  expect(process.env[CLIENT_KEY_ENV]).toBeUndefined()
  execute.mockRejectedValueOnce(
    Object.assign(new Error('missing'), { code: 1 }),
  )
  await expect(
    writeClientEnvironment(null, 'win32', execute, loadNotifier),
  ).resolves.toBeUndefined()
  execute.mockRejectedValueOnce(new Error('denied'))
  await expect(
    writeClientEnvironment('key', 'win32', execute, loadNotifier),
  ).rejects.toThrow('environmentFailed')
  expect(notify).toHaveBeenCalledTimes(3)
  expect(execute.mock.calls.every(([command]) => command === 'reg.exe')).toBe(
    true,
  )
})

test('notifies after persisting the full Windows key and updating the current process', async () => {
  const value = 'long-key-' + 'x'.repeat(4096) + '-"$()&'
  const operations: string[] = []
  execute.mockImplementation(async () => {
    operations.push('write')
    return { stdout: '', stderr: '' }
  })
  loadNotifier.mockImplementation(async () => {
    operations.push('load')
    return notify
  })
  notify.mockImplementation(async () => {
    expect(process.env[CLIENT_KEY_ENV]).toBe(value)
    operations.push('notify')
    return true
  })
  await writeClientEnvironment(value, 'win32', execute, loadNotifier)
  expect(operations).toEqual(['load', 'write', 'notify'])
  expect(execute.mock.calls[0][1]).toContain(value)
})

test('does not mutate Windows credentials when the native binding cannot load', async () => {
  process.env[CLIENT_KEY_ENV] = 'previous-key'
  loadNotifier.mockRejectedValueOnce(new Error('native load failed'))
  await expect(
    writeClientEnvironment('new-key', 'win32', execute, loadNotifier),
  ).rejects.toThrow('environmentFailed')
  expect(execute).not.toHaveBeenCalled()
  expect(notify).not.toHaveBeenCalled()
  expect(process.env[CLIENT_KEY_ENV]).toBe('previous-key')
})

test('does not notify or change the process value after a registry write failure', async () => {
  process.env[CLIENT_KEY_ENV] = 'previous-key'
  execute.mockRejectedValueOnce(new Error('access denied'))
  await expect(
    writeClientEnvironment('new-key', 'win32', execute, loadNotifier),
  ).rejects.toThrow('environmentFailed')
  expect(notify).not.toHaveBeenCalled()
  expect(process.env[CLIENT_KEY_ENV]).toBe('previous-key')
})

test.each(['timeout', 'error'])(
  'keeps successful Windows persistence when notification has a %s',
  async (failure) => {
    if (failure === 'timeout') notify.mockResolvedValueOnce(false)
    else notify.mockRejectedValueOnce(new Error('private native error'))
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        writeClientEnvironment('new-key', 'win32', execute, loadNotifier),
      ).resolves.toBeUndefined()
      expect(process.env[CLIENT_KEY_ENV]).toBe('new-key')
      expect(execute).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('new-key')
    } finally {
      warn.mockRestore()
    }
  },
)

test.each(['darwin', 'linux'] as const)(
  'does not load the Windows binding on %s',
  async (platform) => {
    loadNotifier.mockRejectedValue(new Error('must not load'))
    await writeClientEnvironment('key', platform, execute, loadNotifier)
    expect(process.env[CLIENT_KEY_ENV]).toBe('key')
    expect(loadNotifier).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  },
)
test('reads, sets and clears macOS launch environment values and handles an absent value', async () => {
  execute.mockResolvedValueOnce({ stdout: 'key\n', stderr: '' })
  expect(await readClientEnvironment('darwin', execute)).toBe('key')
  execute.mockRejectedValueOnce(
    Object.assign(new Error('missing'), { code: 1 }),
  )
  expect(await readClientEnvironment('darwin', execute)).toBeNull()
  await writeClientEnvironment('new-key', 'darwin', execute)
  expect(execute.mock.calls[2][1]).toEqual([
    'setenv',
    CLIENT_KEY_ENV,
    'new-key',
  ])
  await writeClientEnvironment(null, 'darwin', execute)
  expect(execute.mock.calls[3][1]).toEqual(['unsetenv', CLIENT_KEY_ENV])
  execute.mockRejectedValueOnce(new Error('denied'))
  await expect(readClientEnvironment('darwin', execute)).rejects.toThrow(
    'environmentFailed',
  )
  execute.mockRejectedValueOnce(new Error('denied'))
  await expect(
    writeClientEnvironment('key', 'darwin', execute),
  ).rejects.toThrow('environmentFailed')
})
test('patches shell startup files idempotently, quotes keys, and escapes persistent macOS XML', async () => {
  const value = `key'$HOME"<&`
  const patched = patchShellEnvironment('# original', value)
  expect(patched).toStartWith('# original\n')
  expect(patched).toContain(`'"'"'`)
  expect(patchShellEnvironment(patched, value)).toBe(patched)
  expect(patchShellEnvironment(patched, 'new')).not.toContain(value)
  expect(() =>
    patchShellEnvironment('# >>> copilot-api client key >>>', 'key'),
  ).toThrow('invalidConfig')
  expect(() =>
    patchShellEnvironment('# <<< copilot-api client key <<<', 'key'),
  ).toThrow('invalidConfig')
  expect(macEnvironmentAgent(value)).toContain('&apos;$HOME&quot;&lt;&amp;')
  await writeClientEnvironment('linux-key', 'linux', execute)
  expect(await readClientEnvironment('linux', execute)).toBe('linux-key')
  await writeClientEnvironment(null, 'linux', execute)
  expect(await readClientEnvironment('linux', execute)).toBeNull()
  expect(execute).not.toHaveBeenCalled()
})
