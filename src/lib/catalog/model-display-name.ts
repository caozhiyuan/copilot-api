/** Keep upstream labels as the base and identify their gateway provider. */
export function withModelDisplayName<T>(model: T, provider?: string): T {
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    return model
  }
  const fields = model as {
    display_name?: unknown
    name?: unknown
    id?: unknown
  }
  const hasDisplayName = Object.hasOwn(model, "display_name")
  let displayName =
    hasDisplayName ? fields.display_name
    : typeof fields.name === "string" && fields.name.trim() ? fields.name
    : fields.id
  const providerName = provider?.trim()
  if (
    providerName
    && typeof displayName === "string"
    && displayName.trim()
    && !displayName.startsWith(`${providerName} `)
    && !displayName.endsWith(` (${providerName})`)
  ) {
    displayName = `${displayName} (${providerName})`
  }
  if (hasDisplayName && displayName === fields.display_name) return model
  return { ...model, display_name: displayName }
}
