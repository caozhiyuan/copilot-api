import type { ProviderModelOptions } from '../types/ipc'

export function parseModelSelection(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ]
}

export function mergeProviderModelOptions(
  local: ProviderModelOptions,
  discovered: unknown,
): ProviderModelOptions {
  const result = Object.fromEntries(
    Object.entries(local).map(([name, ids]) => [name, [...ids]]),
  )
  if (!discovered || typeof discovered !== 'object') return result
  const models = 'data' in discovered ? discovered.data : undefined
  if (!Array.isArray(models)) return result
  for (const model of models as unknown[]) {
    if (!model || typeof model !== 'object' || !('id' in model)) continue
    const id = model.id
    if (typeof id !== 'string') continue
    for (const [name, ids] of Object.entries(result)) {
      const prefix = `${name}/`
      if (id.startsWith(prefix) && id.length > prefix.length) {
        ids.push(id.slice(prefix.length))
        break
      }
      if (
        name === 'github-copilot'
        && !Object.keys(result).some(
          (provider) =>
            provider !== 'github-copilot' && id.startsWith(`${provider}/`),
        )
      ) {
        ids.push(id)
        break
      }
    }
  }
  return Object.fromEntries(
    Object.entries(result).map(([name, ids]) => [
      name,
      [...new Set(ids)].sort(),
    ]),
  )
}
