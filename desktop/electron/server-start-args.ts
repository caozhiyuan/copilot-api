export function buildServerStartEnv(
  parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parentEnv,
    NODE_ENV: 'production',
    NODE_USE_SYSTEM_CA: parentEnv.NODE_USE_SYSTEM_CA ?? '1',
  }
  delete env.COPILOT_API_GITHUB_TOKEN
  return env
}

export function buildServerStartArgs(
  port: number,
  host?: string | null,
): string[] {
  const args = ['start', '--port', String(port)]
  const normalizedHost = host?.trim()

  if (normalizedHost) {
    args.push('--host', normalizedHost)
  }

  return args
}
