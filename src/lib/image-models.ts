export const DEFAULT_IMAGE_MODELS = {
  codex: "gpt-image-2",
  "github-copilot": "gpt-image-2.5-flare",
  xai: "grok-imagine-image-2.0",
} as const

export const IMAGE_PROVIDER_PRIORITY = [
  "codex",
  "github-copilot",
  "xai",
] as const

export type ImageProvider = (typeof IMAGE_PROVIDER_PRIORITY)[number]

export function getDefaultImageModel(provider: string): string | undefined {
  const name = IMAGE_PROVIDER_PRIORITY.find(
    (candidate) => candidate === provider,
  )
  return name ? DEFAULT_IMAGE_MODELS[name] : undefined
}

/** Model discovery includes defaults only for providers with usable credentials. */
export function selectDefaultImageModel(
  modelIds: Iterable<string>,
): string | undefined {
  const available = new Set(modelIds)
  for (const provider of IMAGE_PROVIDER_PRIORITY) {
    const id = `${provider}/${DEFAULT_IMAGE_MODELS[provider]}`
    if (available.has(id)) return id
  }
  return undefined
}
