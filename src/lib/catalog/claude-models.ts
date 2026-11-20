const DISCOVERY_MODEL_PREFIX = "my-claude-"
const DISCOVERY_MODEL_SUFFIX = "[1m]"

export function isClaudeUserAgent(userAgent: string | undefined): boolean {
  return userAgent?.toLowerCase().includes("claude") ?? false
}

/** Advertise every discovery ID with [1m], keeping its provider namespace. */
export function toClaudeDiscoveryModelId(modelId: string): string {
  const discoveryId = `${stripDiscoveryModelSuffix(modelId)}${DISCOVERY_MODEL_SUFFIX}`
  if (discoveryId.toLowerCase().includes("claude")) return discoveryId
  const modelStart = discoveryId.indexOf("/") + 1
  const model = discoveryId.slice(modelStart)
  return `${discoveryId.slice(0, modelStart)}${DISCOVERY_MODEL_PREFIX}${model}`
}

/** Restore the upstream ID before model mappings and provider resolution. */
export function fromClaudeDiscoveryModelId(modelId: string): string {
  const upstreamId = stripDiscoveryModelSuffix(modelId)
  if (upstreamId.startsWith(DISCOVERY_MODEL_PREFIX)) {
    return upstreamId.slice(DISCOVERY_MODEL_PREFIX.length)
  }
  const modelStart = upstreamId.indexOf("/") + 1
  const model = upstreamId.slice(modelStart)
  if (!model.startsWith(DISCOVERY_MODEL_PREFIX)) return upstreamId
  return `${upstreamId.slice(0, modelStart)}${model.slice(DISCOVERY_MODEL_PREFIX.length)}`
}

function stripDiscoveryModelSuffix(modelId: string): string {
  return modelId.endsWith(DISCOVERY_MODEL_SUFFIX) ?
      modelId.slice(0, -DISCOVERY_MODEL_SUFFIX.length)
    : modelId
}
