import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import {
  detectBunRuntime,
  getBunCandidates,
  isSupportedBunVersion,
} from '../electron/bun-runtime'
import { normalizeSettings } from '../electron/settings-store'

describe('Bun runtime detection', () => {
  test.each(['1.4.0', '1.4.3', '1.5.0', '2.0.0', '1.4.0+build.1', ' 1.4.0\n'])(
    'accepts supported stable version %s',
    (version) => {
      expect(isSupportedBunVersion(version)).toBe(true)
    },
  )
  test.each([
    '1.3.99',
    '0.4.0',
    '1.4.0-canary.1',
    '1.4',
    'garbage',
    '',
    '1.4.0\n2.0.0',
  ])('rejects unsupported or invalid version %s', (version) => {
    expect(isSupportedBunVersion(version)).toBe(false)
  })

  test('searches absolute PATH entries and GUI install locations without a shell', () => {
    expect(
      getBunCandidates({
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

  test('recognizes Windows PATH casing, quoted directories, and standard installs', () => {
    const candidates = getBunCandidates({
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
      'c:\\TOOLS\\bun.exe',
      'C:\\Users\\test\\.bun\\bin\\bun.exe',
      'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe',
      'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\bun.exe',
    ])
  })

  test('ignores relative BUN_INSTALL and handles an absent PATH', () => {
    expect(
      getBunCandidates({
        env: { BUN_INSTALL: 'relative' },
        homeDir: '/users/test',
        platform: 'linux',
      })[0],
    ).toBe('/users/test/.bun/bin/bun')
  })

  test('skips missing and outdated candidates to find a supported installation', async () => {
    const checked: string[] = []
    const result = await detectBunRuntime({
      env: { PATH: '/missing:/old:/supported' },
      platform: 'linux',
      homeDir: '/users/test',
      getVersion: async (candidate) => {
        checked.push(candidate)
        if (candidate === '/missing/bun') throw new Error('ENOENT')
        return candidate === '/old/bun' ? '1.3.14' : '1.4.0\n'
      },
    })
    expect(result).toEqual({
      available: true,
      version: '1.4.0',
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

  test('probes a real Bun executable', async () => {
    const executable = Bun.which('bun')
    if (!executable) throw new Error('The Bun test runner must be on PATH')
    const result = await detectBunRuntime({
      env: { PATH: path.dirname(executable) },
    })
    expect(result.available).toBe(true)
    expect(result.version).toBe(Bun.version)
  })

  test('defaults existing and invalid settings to Bun while retaining Node selection', () => {
    expect(normalizeSettings(null).serverRuntime).toBe('bun')
    expect(normalizeSettings({}).serverRuntime).toBe('bun')
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
