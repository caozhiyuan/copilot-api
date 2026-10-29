import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  beginMacUpdateStartup,
  canInstallMacUpdate,
  getMacApplicationPath,
  installMacUpdate,
  markMacUpdateReady,
} from '../electron/mac-update-install'

let directory: string
let appPath: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'mac-install-test-'))
  appPath = path.join(directory, 'Copilot API.app')
  await mkdir(path.join(appPath, 'Contents'), { recursive: true })
  await writeFile(path.join(appPath, 'Contents/old'), 'old application')
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

function setup() {
  const beforeQuit = mock(async () => {})
  const quit = mock(() => {})
  const launchInstaller = mock(async (_file: string, _args: string[]) => {})
  const metadata = {
    CFBundleIdentifier: 'com.copilot-api.desktop',
    CFBundleShortVersionString: '2.7.44',
  }
  let mount = ''
  const execute = mock(async (file: string, args: string[]) => {
    if (file.endsWith('hdiutil') && args[0] === 'attach') {
      mount = args[args.indexOf('-mountpoint') + 1]
      await mkdir(path.join(mount, 'Copilot API.app/Contents'), {
        recursive: true,
      })
      await writeFile(
        path.join(mount, 'Copilot API.app/Contents/new'),
        'new application',
      )
    } else if (file.endsWith('hdiutil') && args[0] === 'detach') {
      await rm(path.join(mount, 'Copilot API.app'), {
        recursive: true,
        force: true,
      })
    } else if (file.endsWith('plutil')) {
      return { stdout: metadata[args[1] as keyof typeof metadata] }
    } else if (file.endsWith('ditto')) {
      await cp(args[0], args[1], { recursive: true })
    }
    return { stdout: '' }
  })
  const options = {
    appPath,
    dmgPath: path.join(directory, 'update.dmg'),
    version: '2.7.44',
    userData: directory,
    beforeQuit,
    quit,
    execute,
    launchInstaller,
  }
  return { options, execute, metadata, beforeQuit, quit, launchInstaller }
}

describe('macOS installation preparation', () => {
  test('keeps the running app open when its bundle is not writable', async () => {
    const originalAccess = fs.access
    const denied = spyOn(fs, 'access').mockImplementation(
      async (file, mode) => {
        if (file === appPath && mode === constants.W_OK)
          throw new Error('App bundle is not writable')
        await originalAccess(file, mode)
      },
    )
    try {
      expect(await canInstallMacUpdate(appPath)).toBe(false)
      const { options, beforeQuit, quit, launchInstaller } = setup()
      await expect(installMacUpdate(options)).rejects.toThrow('manual')
      expect(beforeQuit).not.toHaveBeenCalled()
      expect(quit).not.toHaveBeenCalled()
      expect(launchInstaller).not.toHaveBeenCalled()
    } finally {
      denied.mockRestore()
    }
  })

  test('only offers automatic installation for a real writable app outside restricted locations', async () => {
    expect(
      getMacApplicationPath(path.join(appPath, 'Contents/MacOS/Copilot API')),
    ).toBe(appPath)
    expect(() =>
      getMacApplicationPath('/tmp/other/Contents/MacOS/App'),
    ).toThrow('packaged')
    expect(await canInstallMacUpdate(appPath)).toBe(true)
    expect(await canInstallMacUpdate(path.join(directory, 'missing.app'))).toBe(
      false,
    )
    const wrong = path.join(directory, 'Other.app')
    await mkdir(wrong)
    expect(await canInstallMacUpdate(wrong)).toBe(false)
    const translocated = path.join(
      directory,
      'AppTranslocation/private/Copilot API.app',
    )
    await mkdir(translocated, { recursive: true })
    expect(await canInstallMacUpdate(translocated)).toBe(false)
    const linked = path.join(directory, 'linked/Copilot API.app')
    await mkdir(path.dirname(linked))
    await symlink(appPath, linked)
    expect(await canInstallMacUpdate(linked)).toBe(false)
    await rm(appPath, { recursive: true })
    await writeFile(appPath, 'not a directory')
    expect(await canInstallMacUpdate(appPath)).toBe(false)
  })

  test('extracts and validates a complete staged app before stopping the gateway', async () => {
    const { options, beforeQuit, quit, launchInstaller } = setup()
    beforeQuit.mockImplementation(async () => {
      expect(await readFile(path.join(appPath, 'Contents/old'), 'utf8')).toBe(
        'old application',
      )
      const args = launchInstaller.mock.calls[0][1]
      expect(await readFile(path.join(args[2], 'Contents/new'), 'utf8')).toBe(
        'new application',
      )
    })
    await installMacUpdate(options)
    expect(beforeQuit).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    const args = launchInstaller.mock.calls[0][1]
    expect(args[0]).toBe(String(process.pid))
    expect(path.dirname(path.dirname(args[2]))).toBe(directory)
    expect(
      await readFile(path.join(args[4], 'attempt.json'), 'utf8'),
    ).toContain('2.7.44')
  })

  test('refuses wrong identities or versions and cleans staging without stopping a healthy app', async () => {
    for (const key of [
      'CFBundleIdentifier',
      'CFBundleShortVersionString',
    ] as const) {
      const { options, metadata, beforeQuit, quit, execute } = setup()
      metadata[key] = 'wrong'
      await expect(installMacUpdate(options)).rejects.toThrow(key)
      expect(beforeQuit).not.toHaveBeenCalled()
      expect(quit).not.toHaveBeenCalled()
      expect(execute.mock.calls.some((call) => call[1][0] === 'detach')).toBe(
        true,
      )
      expect(
        (await readdir(directory)).filter((name) =>
          name.startsWith('.copilot-api-update-'),
        ),
      ).toEqual([])
    }
  })

  test('does not quit if extraction or helper launch fails', async () => {
    const first = setup()
    first.execute.mockImplementation(async () => {
      throw new Error('DMG could not mount')
    })
    await expect(installMacUpdate(first.options)).rejects.toThrow('mount')
    expect(first.beforeQuit).not.toHaveBeenCalled()
    const second = setup()
    second.launchInstaller.mockRejectedValueOnce(new Error('helper failed'))
    await expect(installMacUpdate(second.options)).rejects.toThrow(
      'helper failed',
    )
    expect(second.quit).not.toHaveBeenCalled()
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith('.copilot-api-update-'),
      ),
    ).toEqual([])
  })

  test('cancels a launched helper if stopping the server fails', async () => {
    const { options, beforeQuit, launchInstaller, quit } = setup()
    beforeQuit.mockRejectedValueOnce(new Error('server stop failed'))
    await expect(installMacUpdate(options)).rejects.toThrow(
      'server stop failed',
    )
    expect(quit).not.toHaveBeenCalled()
    expect(
      await readFile(
        path.join(launchInstaller.mock.calls[0][1][4], 'cancelled'),
        'utf8',
      ),
    ).toBe('cancelled')
  })

  test('real detached shell acknowledges startup before the gateway is stopped', async () => {
    const { options, beforeQuit, quit } = setup()
    beforeQuit.mockRejectedValueOnce(
      new Error('deliberately keep test parent alive'),
    )
    await expect(
      installMacUpdate({ ...options, launchInstaller: undefined }),
    ).rejects.toThrow('keep test parent alive')
    expect(quit).not.toHaveBeenCalled()
    const states = await readdir(path.join(directory, 'updates'))
    const state = path.join(directory, 'updates', states[0])
    const pid = Number(
      await readFile(path.join(state, 'installer-ready'), 'utf8'),
    )
    expect(pid).toBeGreaterThan(1)
    // The cancellation marker prevents any replacement while this test parent
    // is alive. End the waiting helper so the test leaves no background process.
    process.kill(pid, 'SIGTERM')
  })

  test('reports real mount errors and invalid application locations', async () => {
    const { options, quit } = setup()
    await expect(
      installMacUpdate({ ...options, execute: undefined }),
    ).rejects.toThrow()
    expect(quit).not.toHaveBeenCalled()
    await expect(
      installMacUpdate({ ...options, appPath: '/missing/Copilot API.app' }),
    ).rejects.toThrow('manual')
  })
})

describe('macOS update startup receipt', () => {
  test('only acknowledges a matching attempt inside the updater state directory', async () => {
    const state = path.join(directory, 'updates/mac-install-abc123')
    await mkdir(state, { recursive: true })
    const argv = [`--copilot-api-update-state=${state}`]
    await writeFile(
      path.join(state, 'attempt.json'),
      JSON.stringify({ appPath, version: '2.7.44' }),
    )
    expect(
      await beginMacUpdateStartup(argv, directory, appPath, '2.7.44'),
    ).toBe(state)
    expect(await readFile(path.join(state, 'started'), 'utf8')).toBe(
      String(process.pid),
    )
    await markMacUpdateReady(state)
    expect(await readFile(path.join(state, 'ready'), 'utf8')).toBe('ready')
    await markMacUpdateReady(null)
    expect(
      await beginMacUpdateStartup(argv, directory, appPath, 'old'),
    ).toBeNull()
    expect(
      await beginMacUpdateStartup(argv, directory, '/another/app', '2.7.44'),
    ).toBeNull()
    for (const invalid of ['null', '{}', '{bad']) {
      await writeFile(path.join(state, 'attempt.json'), invalid)
      expect(
        await beginMacUpdateStartup(argv, directory, appPath, '2.7.44'),
      ).toBeNull()
    }
    expect(
      await beginMacUpdateStartup([], directory, appPath, '2.7.44'),
    ).toBeNull()
    expect(
      await beginMacUpdateStartup(
        ['--copilot-api-update-state=/tmp/arbitrary'],
        directory,
        appPath,
        '2.7.44',
      ),
    ).toBeNull()
    expect(
      await beginMacUpdateStartup(
        [`--copilot-api-update-state=${directory}/updates/wrong`],
        directory,
        appPath,
        '2.7.44',
      ),
    ).toBeNull()
    expect(
      await beginMacUpdateStartup(
        [`--copilot-api-update-state=${directory}/updates/mac-install-missing`],
        directory,
        appPath,
        '2.7.44',
      ),
    ).toBeNull()
  })
})
