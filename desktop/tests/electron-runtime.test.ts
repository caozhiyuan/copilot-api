import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron') as string

const MINIMUM_NODE_VERSIONS = [
  [22, 23, 4],
  [24, 22, 1],
  [26, 12, 1],
] as const

function isPatchedNodeVersion(version: string): boolean {
  const parts = version.split('.').map(Number)
  if (
    parts.length !== 3
    || parts.some((part) => !Number.isInteger(part) || part < 0)
  ) {
    return false
  }

  const [major] = parts
  if (major === undefined) return false
  if (major > 26) return true

  const minimum = MINIMUM_NODE_VERSIONS.find(
    ([minimumMajor]) => minimumMajor === major,
  )
  if (!minimum) return false

  for (const [index, minimumPart] of minimum.entries()) {
    const part = parts[index] ?? 0
    if (part > minimumPart) return true
    if (part < minimumPart) return false
  }
  return true
}

test.each([
  ['22.23.3', false],
  ['22.23.4', true],
  ['24.22.0', false],
  ['24.22.1', true],
  ['25.0.0', false],
  ['26.12.0', false],
  ['26.12.1', true],
  ['27.0.0', true],
])('validates Node.js security version %s', (version, expected) => {
  expect(isPatchedNodeVersion(version)).toBe(expected)
})

test('bundled Electron uses a patched Node.js runtime', () => {
  const result = spawnSync(
    electronExecutable,
    [
      '-p',
      'JSON.stringify({ electron: process.versions.electron, node: process.versions.node })',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 10_000,
    },
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)

  const versions = JSON.parse(result.stdout) as {
    electron: string
    node: string
  }
  expect(
    isPatchedNodeVersion(versions.node),
    `Electron ${versions.electron} uses unsupported Node.js ${versions.node}`,
  ).toBe(true)
})
