import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  detectBunRuntime,
  getBunCandidates,
  isSupportedBunVersion,
} from '../electron/bun-runtime'
import { normalizeSettings } from '../electron/settings-store'

describe('Bun runtime detection', () => {
  test.each(['1.4.4', '1.4.5', '1.5.0', '2.0.0', '1.4.4+build.1', ' 1.4.4\n'])(
    'accepts supported stable version %s',
    (version) => {
      expect(isSupportedBunVersion(version)).toBe(true)
    },
  )
  test.each([
    '1.4.0',
    '1.4.3',
    '1.3.99',
    '0.4.0',
    '1.4.4-canary.1',
    '1.4',
    'garbage',
    '',
    '1.4.4\n2.0.0',
  ])('rejects unsupported or invalid version %s', (version) => {
    expect(isSupportedBunVersion(version)).toBe(false)
  })

  test('searches absolute PATH entries and GUI install locations without a shell', async () => {
    expect(
      await getBunCandidates({
        env: {
          PATH: '/custom/bin::.:relative:/custom/bin',
          BUN_INSTALL: '/opt/bun',
        },
        homeDir: '/users/test',
        platform: 'darwin',
      }),
    ).toEqual([
      '/custom/bin/bun',
      '/opt/bun/bin/bun',
      '/users/test/.bun/bin/bun',
      '/opt/homebrew/bin/bun',
      '/usr/local/bin/bun',
      '/usr/bin/bun',
    ])
  })

  test('recognizes Windows PATH casing, quoted directories, and standard installs', async () => {
    const candidates = await getBunCandidates({
      env: {
        Path: '"C:\\Program Files\\Bun";C:\\tools;c:\\TOOLS;.;',
        APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      },
      homeDir: 'C:\\Users\\test',
      platform: 'win32',
    })
    expect(candidates).toEqual([
      'C:\\Program Files\\Bun\\bun.exe',
      'C:\\Program Files\\Bun\\node_modules\\bun\\bin\\bun.exe',
      'c:\\TOOLS\\bun.exe',
      'c:\\TOOLS\\node_modules\\bun\\bin\\bun.exe',
      'C:\\Users\\test\\.bun\\bin\\bun.exe',
      'C:\\Users\\test\\AppData\\Roaming\\npm\\bun.exe',
      'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe',
      'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\bun.exe',
    ])
  })

  test('skips nvm-windows 2 shim and launches the real Bun', async () => {
    const nvmRoot = 'C:\\Users\\test\\AppData\\Local\\Author Software\\nvm'
    const installs = path.win32.join(nvmRoot, 'installs')
    const shim = path.win32.join(nvmRoot, '.shim', 'bun.exe')
    const real = path.win32.join(
      installs,
      'v24.22.2',
      'node_modules',
      'bun',
      'bin',
      'bun.exe',
    )
    const checked: string[] = []
    const options = {
      env: {
        Path: [path.win32.join(nvmRoot, '.shim'), 'D:\\tools\\.shim'].join(';'),
        NVM_SYMLINK: path.win32.join(nvmRoot, '.shim'),
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      },
      homeDir: 'C:\\Users\\test',
      platform: 'win32' as const,
      readDirectory: async (directory: string) => {
        if (directory === installs) return ['v24.22.2']
        throw new Error('ENOENT')
      },
      getVersion: async (candidate: string) => {
        checked.push(candidate)
        if (candidate === real || candidate === shim) return '1.4.4'
        throw new Error('ENOENT')
      },
    }

    const candidates = await getBunCandidates(options)
    expect(candidates).not.toContain(shim)
    expect(candidates).toContain('D:\\tools\\.shim\\bun.exe')
    expect(candidates).toContain(real)
    expect(await detectBunRuntime(options)).toEqual({
      available: true,
      version: '1.4.4',
      path: real,
    })
    expect(checked).not.toContain(shim)
  })

  test('ignores relative BUN_INSTALL and handles an absent PATH', async () => {
    expect(
      (
        await getBunCandidates({
          env: { BUN_INSTALL: 'relative' },
          homeDir: '/users/test',
          platform: 'linux',
        })
      )[0],
    ).toBe('/users/test/.bun/bin/bun')
  })

  test.each(['darwin', 'linux'] as const)(
    'uses active nvm and npm prefix directories on %s without PATH',
    async (platform) => {
      const candidates = await getBunCandidates({
        env: {
          NVM_BIN: '/custom nvm/versions/node/v24.0.0/bin',
          npm_config_prefix: '/custom npm',
        },
        homeDir: '/users/test',
        platform,
        readDirectory: async () => [],
      })
      expect(candidates.slice(0, 2)).toEqual([
        '/custom nvm/versions/node/v24.0.0/bin/bun',
        '/custom npm/bin/bun',
      ])
    },
  )

  test('uses native npm executables under the active nvm-windows link and prefix', async () => {
    const candidates = await getBunCandidates({
      env: {
        NVM_SYMLINK: 'C:\\Program Files\\nodejs',
        NPM_CONFIG_PREFIX: 'D:\\global npm',
      },
      platform: 'win32',
      homeDir: 'C:\\Users\\test',
      readDirectory: async () => [],
    })
    expect(candidates.slice(0, 4)).toEqual([
      'C:\\Program Files\\nodejs\\bun.exe',
      'C:\\Program Files\\nodejs\\node_modules\\bun\\bin\\bun.exe',
      'D:\\global npm\\bun.exe',
      'D:\\global npm\\node_modules\\bun\\bin\\bun.exe',
    ])
    expect(candidates.some((candidate) => candidate.endsWith('.cmd'))).toBe(
      false,
    )
  })

  const nvmInstallations = [
    [
      'macOS custom NVM_DIR',
      'darwin',
      { NVM_DIR: '/custom nvm' },
      '/custom nvm/versions/node',
    ],
    ['Linux default nvm', 'linux', {}, '/users/test/.nvm/versions/node'],
    [
      'Linux XDG_CONFIG_HOME',
      'linux',
      { XDG_CONFIG_HOME: '/config' },
      '/config/nvm/versions/node',
    ],
    [
      'macOS default XDG',
      'darwin',
      {},
      '/users/test/.config/nvm/versions/node',
    ],
    [
      'Windows custom NVM_HOME',
      'win32',
      { NVM_HOME: 'D:\\custom nvm' },
      'D:\\custom nvm',
    ],
    [
      'Windows APPDATA',
      'win32',
      { APPDATA: 'D:\\Roaming' },
      'D:\\Roaming\\nvm',
    ],
    [
      'Windows LOCALAPPDATA',
      'win32',
      { LOCALAPPDATA: 'D:\\Local' },
      'D:\\Local\\nvm',
    ],
    [
      'Windows default roaming',
      'win32',
      {},
      'C:\\Users\\test\\AppData\\Roaming\\nvm',
    ],
    [
      'Windows default local',
      'win32',
      {},
      'C:\\Users\\test\\AppData\\Local\\nvm',
    ],
  ] as const

  for (const [name, platform, env, versionsRoot] of nvmInstallations) {
    test(`detects npm-installed Bun in ${name} without shell initialization`, async () => {
      const windows = platform === 'win32'
      const paths = windows ? path.win32 : path.posix
      const executable = paths.join(
        versionsRoot,
        'v24.10.0',
        ...(windows ?
          ['node_modules', 'bun', 'bin', 'bun.exe']
        : ['bin', 'bun']),
      )
      const result = await detectBunRuntime({
        env,
        platform,
        homeDir: windows ? 'C:\\Users\\test' : '/users/test',
        readDirectory: async (directory) => {
          if (directory !== versionsRoot) throw new Error('ENOENT')
          return ['v24.10.0']
        },
        getVersion: async (candidate) => {
          if (candidate !== executable) throw new Error('ENOENT')
          return '1.4.4'
        },
      })
      expect(result).toEqual({
        available: true,
        version: '1.4.4',
        path: executable,
      })
    })
  }

  test('sorts nvm versions numerically and falls back when newer Node versions lack supported Bun', async () => {
    const checked: string[] = []
    const result = await detectBunRuntime({
      env: {},
      platform: 'linux',
      homeDir: '/users/test',
      readDirectory: async (directory) => {
        if (directory !== '/users/test/.nvm/versions/node')
          throw new Error('EACCES')
        return [
          'v9.0.0',
          'v24.2.0',
          'v24.10.0',
          'v24.9.0',
          'alias',
          '../escape',
          'v24.0.0-beta',
        ]
      },
      getVersion: async (candidate) => {
        checked.push(candidate)
        if (candidate.endsWith('/v24.9.0/bin/bun')) return '1.3.14'
        if (candidate.endsWith('/v24.2.0/bin/bun')) return '1.4.4'
        throw new Error('ENOENT')
      },
    })
    expect(result).toEqual({
      available: true,
      version: '1.4.4',
      path: '/users/test/.nvm/versions/node/v24.2.0/bin/bun',
    })
    expect(
      checked.filter((candidate) => candidate.includes('/versions/node/')),
    ).toEqual([
      '/users/test/.nvm/versions/node/v24.10.0/bin/bun',
      '/users/test/.nvm/versions/node/v24.9.0/bin/bun',
      '/users/test/.nvm/versions/node/v24.2.0/bin/bun',
    ])
  })

  test('preserves PATH priority and deduplicates nvm candidates', async () => {
    const executable = '/users/test/.nvm/versions/node/v24.0.0/bin/bun'
    const candidates = await getBunCandidates({
      env: {
        PATH: path.posix.dirname(executable),
        NVM_BIN: path.posix.dirname(executable),
        NVM_DIR: '/users/test/.nvm',
      },
      platform: 'linux',
      homeDir: '/users/test',
      readDirectory: async () => ['v24.0.0'],
    })
    expect(candidates[0]).toBe(executable)
    expect(
      candidates.filter((candidate) => candidate === executable),
    ).toHaveLength(1)
  })

  test.each(['darwin', 'linux', 'win32'] as const)(
    'ignores relative nvm and npm locations and inaccessible directories on %s',
    async (platform) => {
      const paths = platform === 'win32' ? path.win32 : path.posix
      const scanned: string[] = []
      const candidates = await getBunCandidates({
        env: {
          NVM_DIR: 'relative',
          NVM_HOME: 'relative',
          NVM_BIN: 'relative',
          NVM_SYMLINK: 'relative',
          NPM_CONFIG_PREFIX: 'relative',
          XDG_CONFIG_HOME: 'relative',
        },
        homeDir: platform === 'win32' ? 'C:\\Users\\test' : '/users/test',
        platform,
        readDirectory: async (directory) => {
          scanned.push(directory)
          throw new Error('EACCES')
        },
      })
      expect(candidates.every((candidate) => paths.isAbsolute(candidate))).toBe(
        true,
      )
      expect(scanned.every((directory) => paths.isAbsolute(directory))).toBe(
        true,
      )
      expect(
        candidates.some((candidate) => candidate.includes('relative')),
      ).toBe(false)
    },
  )

  test('skips missing and outdated candidates to find a supported installation', async () => {
    const checked: string[] = []
    const result = await detectBunRuntime({
      env: { PATH: '/missing:/old:/supported' },
      platform: 'linux',
      homeDir: '/users/test',
      getVersion: async (candidate) => {
        checked.push(candidate)
        if (candidate === '/missing/bun') throw new Error('ENOENT')
        return candidate === '/old/bun' ? '1.3.14' : '1.4.4\n'
      },
    })
    expect(result).toEqual({
      available: true,
      version: '1.4.4',
      path: '/supported/bun',
    })
    expect(checked).toEqual(['/missing/bun', '/old/bun', '/supported/bun'])
  })

  test('reports an unsupported version when no supported installation exists', async () => {
    expect(
      await detectBunRuntime({
        env: { PATH: '/old' },
        platform: 'linux',
        homeDir: '/users/test',
        getVersion: async (candidate) => {
          if (candidate === '/old/bun') return '1.3.14'
          throw new Error('ENOENT')
        },
      }),
    ).toEqual({ available: false, version: '1.3.14', path: '/old/bun' })
  })

  test('reports unavailable when all candidates fail', async () => {
    expect(
      await detectBunRuntime({
        env: {},
        platform: 'linux',
        homeDir: '/users/test',
        getVersion: async () => {
          throw new Error('timeout')
        },
      }),
    ).toEqual({ available: false })
  })

  // Copying and scanning a native executable can exceed Bun's default 5s deadline.
  test('executes native Bun in an npm/nvm installation with spaces and no PATH', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot bun nvm '))
    try {
      const windows = process.platform === 'win32'
      const nvmHome = path.join(homeDir, '.nvm')
      const prefix =
        windows ?
          path.join(nvmHome, 'v24.0.0')
        : path.join(nvmHome, 'versions', 'node', 'v24.0.0')
      const binary = path.join(
        prefix,
        ...(windows ? [] : ['lib']),
        'node_modules',
        'bun',
        'bin',
        'bun.exe',
      )
      await fs.mkdir(path.dirname(binary), { recursive: true })
      await fs.copyFile(process.execPath, binary)
      const binDir = windows ? prefix : path.join(prefix, 'bin')
      if (!windows) {
        await fs.mkdir(binDir)
        await fs.symlink(
          path.relative(binDir, binary),
          path.join(binDir, 'bun'),
        )
      }
      const env = windows ? { NVM_HOME: nvmHome } : { NVM_DIR: nvmHome }
      const executable = windows ? binary : path.join(binDir, 'bun')
      expect(await getBunCandidates({ env, homeDir })).toContain(executable)
      const result = await detectBunRuntime({
        env: {
          ...env,
          ...(windows ? { NVM_SYMLINK: binDir } : { NVM_BIN: binDir }),
        },
        homeDir,
      })
      expect(result).toEqual({
        available: true,
        version: Bun.version,
        path: executable,
      })
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true })
    }
  }, 30000)

  test('defaults new installations to Bun and migrates legacy settings to Node', () => {
    expect(normalizeSettings(null).serverRuntime).toBe('bun')
    expect(normalizeSettings(undefined).serverRuntime).toBe('bun')
    expect(normalizeSettings({}).serverRuntime).toBe('node')
    expect(normalizeSettings({ serverRuntime: 'node' }).serverRuntime).toBe(
      'node',
    )
    expect(normalizeSettings({ serverRuntime: 'bun' }).serverRuntime).toBe(
      'bun',
    )
    expect(
      normalizeSettings({ serverRuntime: 'invalid' as 'bun' }).serverRuntime,
    ).toBe('bun')
  })
})
