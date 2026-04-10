function legacyCopyText(text: string): boolean {
  if (
    typeof document === "undefined"
    || typeof document.createElement !== "function"
    || typeof document.execCommand !== "function"
    || !document.body
  ) {
    return false
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  textarea.style.pointerEvents = "none"
  textarea.style.left = "-9999px"
  textarea.style.top = "0"

  document.body.appendChild(textarea)

  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand("copy")
  } finally {
    textarea.remove()
  }
}

function normalizeCopyError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export async function copyText(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return
    } catch (error) {
      const normalizedError = normalizeCopyError(error)

      try {
        if (legacyCopyText(text)) {
          return
        }
      } catch (fallbackError) {
        const normalizedFallbackError = normalizeCopyError(fallbackError)
        throw new Error(
          `${normalizedError.message}; legacy copy fallback threw: ${normalizedFallbackError.message}`,
        )
      }

      throw new Error(
        `${normalizedError.message}; legacy copy fallback was unavailable or returned false.`,
      )
    }
  }

  if (legacyCopyText(text)) {
    return
  }

  throw new Error("Clipboard unavailable")
}
