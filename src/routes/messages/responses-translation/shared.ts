import { THINKING_TEXT } from "../completions-translation"

export const COMPACTION_SIGNATURE_PREFIX = "cm1#"
export const COMPACTION_SIGNATURE_SEPARATOR = "@"

export { THINKING_TEXT }
export const REASONING_SUMMARY_SEPARATOR = "\u00A0\n\n"
export const REASONING_SUMMARY_SEPARATOR_PATTERN = /\u00a0\n\n|\u2063\n\n/

export type CompactionCarrier = {
  id: string
  encrypted_content: string
}

export const encodeCompactionCarrierSignature = (
  compaction: CompactionCarrier,
): string => {
  return `${COMPACTION_SIGNATURE_PREFIX}${compaction.encrypted_content}${COMPACTION_SIGNATURE_SEPARATOR}${compaction.id}`
}

export const decodeCompactionCarrierSignature = (
  signature: string,
): CompactionCarrier | undefined => {
  if (signature.startsWith(COMPACTION_SIGNATURE_PREFIX)) {
    const raw = signature.slice(COMPACTION_SIGNATURE_PREFIX.length)
    const separatorIndex = raw.indexOf(COMPACTION_SIGNATURE_SEPARATOR)

    if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
      return undefined
    }

    const encrypted_content = raw.slice(0, separatorIndex)
    const id = raw.slice(separatorIndex + 1)

    if (!encrypted_content) {
      return undefined
    }

    return {
      id,
      encrypted_content,
    }
  }

  return undefined
}
