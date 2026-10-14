import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

function runManagerScenario(scenario: string): void {
  // Use the real manager without inheriting other suites' Electron/IPC mocks.
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '--eval',
      `
      import assert from 'node:assert/strict'
      import { mock, spyOn } from 'bun:test'
      import childProcess from 'node:child_process'
      import { EventEmitter } from 'node:events'
      let stopExitCode = 0
      let forkError
      let startupExitCode
      let bunRuntime = { available: false }
      let spawnError
      let spawnOptions
      let forkOptions
      const electronApp = { isPackaged: false, getAppPath: () => process.cwd() }
      const processes = []
      const createProcess = () => {
        const proc = new EventEmitter()
        Object.assign(proc, {
          stdout: null, stderr: null,
          kill() { queueMicrotask(() => proc.emit('exit', stopExitCode)); return true },
        })
        processes.push(proc)
        if (spawnError) queueMicrotask(() => proc.emit('error', spawnError))
        else if (startupExitCode !== undefined) queueMicrotask(() => proc.emit('exit', startupExitCode))
        return proc
      }
      await mock.module('./electron/bun-runtime', () => ({ detectBunRuntime: () => Promise.resolve(bunRuntime) }))
      spyOn(childProcess, 'spawn').mockImplementation((...args) => {
        spawnOptions = args
        return createProcess()
      })
      await mock.module('electron', () => ({
        app: electronApp,
        utilityProcess: { fork(...args) {
          forkOptions = args
          if (forkError) throw forkError
          return createProcess()
        } },
      }))
      await mock.module('./electron/i18n', () => ({
        tMain: (key, vars) => Promise.resolve(key + (vars ? ':' + JSON.stringify(vars) : '')),
      }))
      globalThis.fetch = () => Promise.resolve(new Response('ready'))
      const manager = await import('./electron/server-manager')
      const events = []
      manager.onStatusChange((status) => events.push(status))
      try {
        ${scenario}
      } finally {
        manager.clearCallbacks()
        await manager.stopServer()
      }
    `,
    ],
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    timeout: 10_000,
  })
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
}

test.each([0, 1])(
  'broadcasts a planned proxy restart when termination exits with code %i',
  (exitCode) => {
    runManagerScenario(`
      stopExitCode = ${exitCode}
      const initial = await manager.startServer(0, { host: '127.0.0.1' })
      assert.equal(initial.running, true)
      assert.deepEqual(events, [initial])
      events.length = 0
      const restarted = await manager.startServer(0, {
        host: '0.0.0.0',
        proxy: { mode: 'direct', http_proxy: '', https_proxy: '', no_proxy: '' },
      })
      assert.equal(manager.isRunning(), true)
      assert.deepEqual(events, [{ running: false, restarting: true }, restarted])
      assert.deepEqual(restarted, { running: true, port: 0, host: '0.0.0.0' })
    `)
  },
)

test('broadcasts the startup failure after an automatic restart', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    startupExitCode = 7
    const status = await manager.startServer(0)
    assert.equal(status.running, false)
    assert.equal(status.error, 'server.startFailed:{"code":7}')
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [{ running: false, restarting: true }, status])
  `)
})

test('broadcasts a terminal failure if launching the replacement process throws', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    forkError = new Error('cannot launch server')
    await assert.rejects(manager.startServer(0), /cannot launch server/)
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [
      { running: false, restarting: true },
      { running: false, error: 'cannot launch server' },
    ])
  `)
})

test('stops deliberately without reporting a nonzero exit as a crash', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    stopExitCode = 1
    await manager.stopServer()
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [{ running: false, intentional: true }])
  `)
})

test('marks the update installer shutdown as intentional before quitting', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    const { createUpdateManager } = await import('./electron/update-manager')
    let installed = false
    const updater = Object.assign(new EventEmitter(), {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: true,
      allowDowngrade: true,
      checkForUpdates: () => Promise.resolve(null),
      downloadUpdate: () => Promise.resolve([]),
      quitAndInstall() {
        assert.equal(manager.isRunning(), false)
        assert.deepEqual(events, [{ running: false, intentional: true }])
        installed = true
      },
    })
    const updates = createUpdateManager(updater, {
      currentVersion: '2.6.30',
      enabled: true,
      nativeUpdates: true,
      checkRelease: () => Promise.resolve(null),
      beforeInstall: () => manager.stopServer(),
      onStatus: () => {},
    })
    updater.emit('update-downloaded', { version: '2.6.31' })
    await updates.install()
    assert.equal(installed, true)
  `)
})

test.each([0, 9])(
  'still broadcasts an unexpected exit with code %i',
  (code) => {
    runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    processes.at(-1).emit('exit', ${code})
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(manager.isRunning(), false)
    assert.deepEqual(events, [${code === 0 ? '{ running: false }' : '{ running: false, error: \'server.processExit:{"code":"9"}\' }'}])
  `)
  },
)

test('rejects an invalid host without stopping the healthy server', () => {
  runManagerScenario(`
    await manager.startServer(0)
    events.length = 0
    const status = await manager.startServer(0, { host: 'http://bad-host' })
    assert.equal(status.running, false)
    assert.equal(status.error, 'server.invalidHost')
    assert.equal(manager.isRunning(), true)
    assert.deepEqual(events, [])
  `)
})

test('starts the packaged JavaScript directly with supported Bun and preserves proxy flags', () => {
  runManagerScenario(`
    delete process.env.NODE_USE_SYSTEM_CA
    bunRuntime = { available: true, version: '1.4.0', path: '/local/bun' }
    electronApp.isPackaged = true
    Object.defineProperty(process, 'resourcesPath', { value: '/app resources' })
    const status = await manager.startServer(0, {
      runtime: 'bun', verbose: true, showToken: true,
      proxy: { mode: 'custom', http_proxy: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7890', no_proxy: 'localhost' },
    })
    assert.equal(status.running, true)
    assert.equal(spawnOptions[0], '/local/bun')
    assert.equal(spawnOptions[1][0], '--no-orphans')
    assert.equal(spawnOptions[1][1], '--no-install')
    assert.equal(spawnOptions[1][2], '/app resources/server/main.js')
    assert.deepEqual(spawnOptions[1].slice(3), ['start', '--port', '0', '--proxy-env', '--verbose', '--show-token'])
    assert.equal(spawnOptions[2].env.HTTPS_PROXY, 'http://127.0.0.1:7890/')
    assert.equal(spawnOptions[2].env.NODE_USE_SYSTEM_CA, '1')
    assert.equal(spawnOptions[2].env.COPILOT_API_GITHUB_TOKEN, undefined)
    assert.equal(spawnOptions[2].windowsHide, true)
    assert.deepEqual(spawnOptions[2].stdio, ['ignore', 'pipe', 'pipe'])
    assert.ok(manager.getLogs().some((line) => line.includes('Bun 1.4.0')))
  `)
})

test('uses bundled Node when Bun is unavailable or explicitly disabled', () => {
  runManagerScenario(`
    delete process.env.NODE_USE_SYSTEM_CA
    await manager.startServer(0)
    assert.equal(spawnOptions, undefined)
    assert.equal(forkOptions[2].env.NODE_USE_SYSTEM_CA, '1')
    assert.ok(manager.getLogs().some((line) => line.includes('server.bunFallback')))
    bunRuntime = { available: true, version: '1.4.0', path: '/local/bun' }
    await manager.startServer(0, { runtime: 'node' })
    assert.equal(spawnOptions, undefined)
    assert.equal(forkOptions[2].env.NODE_USE_SYSTEM_CA, '1')
    assert.ok(!manager.getLogs().some((line) => line.includes('server.bunFallback')))
  `)
})

test('reports a Bun spawn error without an unhandled error event', () => {
  runManagerScenario(`
    bunRuntime = { available: true, version: '1.4.0', path: '/removed/bun' }
    spawnError = new Error('spawn ENOENT')
    const status = await manager.startServer(0)
    assert.equal(status.running, false)
    assert.equal(status.error, 'server.spawnFailed:{"message":"spawn ENOENT"}')
    assert.equal(manager.isRunning(), false)
  `)
})

test('forces an unresponsive external process to exit before completing a stop', () => {
  runManagerScenario(`
    bunRuntime = { available: true, version: '1.4.0', path: '/local/bun' }
    await manager.startServer(0)
    const proc = processes.at(-1)
    proc.exitCode = null
    const signals = []
    proc.kill = (signal) => {
      signals.push(signal ?? 'SIGTERM')
      if (signal === 'SIGKILL') queueMicrotask(() => proc.emit('exit', null))
      return true
    }
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5000 ? 1 : delay, ...args)
    try {
      await manager.stopServer()
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
      assert.equal(manager.isRunning(), false)
    } finally { globalThis.setTimeout = originalSetTimeout }
  `)
})
