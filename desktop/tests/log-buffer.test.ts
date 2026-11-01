import { describe, expect, test } from 'bun:test'

import {
  BoundedLogBuffer,
  LOG_ENTRY_MAX_TEXT_LENGTH,
  truncateLogText,
} from '../shared/log-buffer'

describe('log buffer', () => {
  test('keeps the tail of oversized log entries with a truncation marker', () => {
    const input = `start-${'a'.repeat(LOG_ENTRY_MAX_TEXT_LENGTH)}-end`
    const truncated = truncateLogText(input)

    expect(truncated.length).toBeLessThanOrEqual(LOG_ENTRY_MAX_TEXT_LENGTH)
    expect(truncated.startsWith('\n… [truncated]')).toBe(true)
    expect(truncated.endsWith('-end')).toBe(true)
  })

  test('does not split a surrogate pair while truncating', () => {
    const marker = '\n… [truncated]'
    const truncated = truncateLogText(
      `prefix-${'🙂'.repeat(10)}`,
      marker.length + 5,
    )
    const firstTailCodeUnit = truncated.charCodeAt(marker.length)

    expect(firstTailCodeUnit >= 0xdc00 && firstTailCodeUnit <= 0xdfff).toBe(
      false,
    )
    expect(truncated.endsWith('🙂')).toBe(true)
  })

  test('returns no partial code point when a tiny budget cannot fit one', () => {
    expect(truncateLogText('🙂', 1)).toBe('')
  })

  test('enforces both entry-count and text-length limits', () => {
    const buffer = new BoundedLogBuffer<string>((log) => log, {
      maxEntries: 3,
      maxTextLength: 5,
    })

    expect(buffer.append('aa')).toBe(true)
    expect(buffer.append('bb')).toBe(true)
    expect(buffer.append('cc')).toBe(true)
    expect(buffer.append('dd')).toBe(true)
    expect(buffer.values()).toEqual(['cc', 'dd'])
  })

  test('clears all retained entries and rejects an entry above the budget', () => {
    const buffer = new BoundedLogBuffer<string>((log) => log, {
      maxEntries: 2,
      maxTextLength: 3,
    })

    expect(buffer.append('ok')).toBe(true)
    expect(buffer.append('large')).toBe(false)
    expect(buffer.values()).toEqual(['ok'])
    buffer.clear()
    expect(buffer.values()).toEqual([])
  })
})
