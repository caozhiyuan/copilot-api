import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { macInstallScript } from '../electron/mac-update-install'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'mac-update-script-'))
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runInstaller(
  options: {
    failMove?: 'backup' | 'replace' | 'restore'
    failLaunch?: boolean
    ready?: boolean
    cancelled?: boolean
    parentAlive?: boolean
    started?: string
  } = {},
) {
  const app = path.join(directory, 'Copilot API.app')
  const staging = await mkdtemp(path.join(directory, '.copilot-api-update-'))
  const staged = path.join(staging, 'Copilot API.app')
  const backup = path.join(staging, 'previous.app')
  const state = path.join(directory, 'state')
  for (const bundle of [app, staged]) await mkdir(bundle)
  await mkdir(state)
  await writeFile(path.join(app, 'version'), 'old')
  await writeFile(path.join(staged, 'version'), 'new')
  if (options.ready) await writeFile(path.join(state, 'ready'), 'ready')
  if (options.cancelled)
    await writeFile(path.join(state, 'cancelled'), 'cancelled')
  if (options.started)
    await writeFile(path.join(state, 'started'), options.started)
  const openLog = path.join(state, 'open.log')
  const open = path.join(directory, 'open')
  await writeFile(
    open,
    `#!/bin/sh
printf '%s\\n' "$*" >>${quote(openLog)}
if [ "$4" = ${quote(`--copilot-api-update-state=${state}`)} ] && [ ${quote(String(!!options.failLaunch))} = true ]; then exit 1; fi
`,
    { mode: 0o700 },
  )
  const move = path.join(directory, 'mv')
  const failSource = {
    backup: app,
    replace: staged,
    restore: backup,
  }[options.failMove ?? 'restore']
  await writeFile(
    move,
    `#!/bin/sh
if [ ${quote(String(!!options.failMove))} = true ] && [ "$1" = ${quote(failSource)} ]; then exit 1; fi
exec /bin/mv "$@"
`,
    { mode: 0o700 },
  )
  const script = path.join(state, 'install.sh')
  // Exercise the production shell flow and real renames. Only replace macOS
  // Launch Services, inject move failures, and shorten polling for these tests.
  await writeFile(
    script,
    macInstallScript
      .replaceAll('/usr/bin/open', quote(open))
      .replaceAll('/bin/mv', quote(move))
      .replaceAll('sleep 1', 'sleep 0.001'),
  )
  const child = Bun.spawn(
    [
      '/bin/sh',
      script,
      String(options.parentAlive ? process.pid : 2147483647),
      app,
      staged,
      backup,
      state,
    ],
    { stdout: 'pipe', stderr: 'pipe', timeout: 5000 },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stdout).toBe('')
  expect(stderr).toBe('')
  const opened = await readFile(openLog, 'utf8').catch(() => '')
  return { app, staging, backup, state, exitCode, opened }
}

describe('macOS detached installation shell', () => {
  test('relaunches the unchanged old app and removes staging if backup fails', async () => {
    const result = await runInstaller({ failMove: 'backup' })
    expect(result.exitCode).toBe(1)
    expect(await readFile(path.join(result.state, 'failed'), 'utf8')).toBe(
      'backup-failed\n',
    )
    expect(await readFile(path.join(result.app, 'version'), 'utf8')).toBe('old')
    expect(result.opened).toContain('--copilot-api-update-failed')
    await expect(readdir(result.staging)).rejects.toThrow()
  })

  for (const failure of ['replace', 'launch', 'startup'] as const) {
    test(`restores the old app and removes staging after ${failure} failure`, async () => {
      const result = await runInstaller({
        failMove: failure === 'replace' ? 'replace' : undefined,
        failLaunch: failure === 'launch',
      })
      expect(result.exitCode).toBe(1)
      expect(await readFile(path.join(result.state, 'failed'), 'utf8')).toBe(
        `${failure}-failed\n`,
      )
      expect(await readFile(path.join(result.app, 'version'), 'utf8')).toBe(
        'old',
      )
      expect(result.opened).toContain('--copilot-api-update-failed')
      await expect(readdir(result.staging)).rejects.toThrow()
    })
  }

  for (const reason of ['cancelled', 'parentAlive'] as const) {
    test(`cleans staging without reopening a running app on ${reason}`, async () => {
      const result = await runInstaller({ [reason]: true })
      expect(result.exitCode).toBe(1)
      expect(await readFile(path.join(result.app, 'version'), 'utf8')).toBe(
        'old',
      )
      expect(result.opened).toBe('')
      await expect(readdir(result.staging)).rejects.toThrow()
      if (reason === 'parentAlive')
        expect(await readFile(path.join(result.state, 'failed'), 'utf8')).toBe(
          'parent-did-not-exit\n',
        )
    })
  }

  test('preserves the previous version and failed app when rollback cannot finish', async () => {
    const result = await runInstaller({ failMove: 'restore' })
    expect(result.exitCode).toBe(1)
    expect(await readFile(path.join(result.backup, 'version'), 'utf8')).toBe(
      'old',
    )
    expect(
      await readFile(path.join(result.staging, 'failed.app/version'), 'utf8'),
    ).toBe('new')
  })

  test('preserves the backup when the new app is still running', async () => {
    const result = await runInstaller({ started: String(process.pid) })
    expect(result.exitCode).toBe(1)
    expect(await readFile(path.join(result.state, 'failed'), 'utf8')).toBe(
      'new-app-still-running\n',
    )
    expect(await readFile(path.join(result.app, 'version'), 'utf8')).toBe('new')
    expect(await readFile(path.join(result.backup, 'version'), 'utf8')).toBe(
      'old',
    )
  })

  test('removes staging and backup only after the new app is ready', async () => {
    const result = await runInstaller({ ready: true })
    expect(result.exitCode).toBe(0)
    expect(await readFile(path.join(result.app, 'version'), 'utf8')).toBe('new')
    expect(await readFile(path.join(result.state, 'result'), 'utf8')).toBe(
      'installed\n',
    )
    await expect(readdir(result.staging)).rejects.toThrow()
  })
})
