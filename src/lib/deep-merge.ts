function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Recursively merges `source` onto `target`, returning a new value without
 * mutating either input.
 *
 * - Plain objects are merged key by key.
 * - Arrays, primitives, `null`, and type mismatches replace the target value.
 */
export function deepMerge<T>(target: T, source: unknown): T {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return source as T
  }

  const result: Record<string, unknown> = { ...target }
  for (const [key, sourceValue] of Object.entries(source)) {
    result[key] = deepMerge(result[key], sourceValue)
  }

  return result as T
}
