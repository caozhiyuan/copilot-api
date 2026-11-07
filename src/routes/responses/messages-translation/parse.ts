import { ResponsesMessagesTranslationError } from "./constants"

export function parseFunctionArguments(
  value: string,
  _path: string,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (isRecord(parsed)) return parsed
  } catch {
    return {}
  }
  return {}
}

export function parseDataUrl(
  value: string,
): { data: string; mediaType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(value)
  if (!match) return null
  return { mediaType: match[1].toLowerCase(), data: match[2] }
}

export function getItemType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === "string" ?
      value.type
    : undefined
}

export function getStringField(
  value: unknown,
  field: string,
): string | undefined {
  if (!isRecord(value)) return undefined
  const fieldValue = value[field]
  return typeof fieldValue === "string" ? fieldValue : undefined
}

export function getOptionalStringField(
  value: unknown,
  field: string,
): string | null | undefined {
  if (!isRecord(value)) return undefined
  const fieldValue = value[field]
  return typeof fieldValue === "string" || fieldValue === null ?
      fieldValue
    : undefined
}

export function requireStringField(
  value: unknown,
  field: string,
  path: string,
): string {
  const result = getStringField(value, field)
  if (!result) {
    throw new ResponsesMessagesTranslationError(`${path}.${field} is required`)
  }
  return result
}

export function getArrayField(value: unknown, field: string): Array<unknown> {
  if (!isRecord(value)) return []
  return Array.isArray(value[field]) ? value[field] : []
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
