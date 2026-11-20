export const FULL_MODEL_CATALOG_HEADER = "x-full-model-catalog"

export function stripInternalRequestHeaders(headers: Headers): Headers {
  const forwarded = new Headers(headers)
  forwarded.delete(FULL_MODEL_CATALOG_HEADER)
  return forwarded
}
