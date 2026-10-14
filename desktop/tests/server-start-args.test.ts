import { expect, test } from 'bun:test'

import {
  buildServerStartArgs,
  buildServerStartEnv,
} from '../electron/server-start-args'

test('reads live saved credentials instead of inheriting a frozen token', () => {
  const inherited = {
    COPILOT_API_GITHUB_TOKEN: 'stale-token',
    COPILOT_API_HOME: 'configured-home',
    NODE_ENV: 'development',
  }
  expect(buildServerStartEnv(inherited)).toEqual({
    COPILOT_API_HOME: 'configured-home',
    NODE_ENV: 'production',
    NODE_USE_SYSTEM_CA: '1',
  })
  expect(inherited.COPILOT_API_GITHUB_TOKEN).toBe('stale-token')
  expect(inherited).not.toHaveProperty('NODE_USE_SYSTEM_CA')
})

test.each(['0', '1'])(
  'preserves explicit system CA setting %s and extra certificates',
  (value) => {
    const inherited = {
      NODE_USE_SYSTEM_CA: value,
      NODE_EXTRA_CA_CERTS: '/custom/ca.pem',
    }
    expect(buildServerStartEnv(inherited)).toEqual({
      ...inherited,
      NODE_ENV: 'production',
    })
    expect(inherited.NODE_USE_SYSTEM_CA).toBe(value)
  },
)

test('passes the host through to the server CLI', () => {
  expect(buildServerStartArgs(4141, '0.0.0.0')).toEqual([
    'start',
    '--port',
    '4141',
    '--host',
    '0.0.0.0',
  ])
})

test('omits the host flag when no host is configured', () => {
  expect(buildServerStartArgs(4141, '   ')).toEqual(['start', '--port', '4141'])
  expect(buildServerStartArgs(4141)).toEqual(['start', '--port', '4141'])
})

test('never puts the GitHub token on the command line', () => {
  expect(buildServerStartArgs(4141, '127.0.0.1')).not.toContain(
    '--github-token',
  )
})
