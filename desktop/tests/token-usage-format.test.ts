import { describe, expect, test } from 'bun:test'
import {
  formatCacheHitRate,
  formatLatency,
  formatOutputSpeed,
} from '../src/lib/token-usage-format'

describe('token usage cache hit rate', () => {
  test.each([
    [200, 600, 200, '60.0%'],
    [200, 0, 100, '0.0%'],
    [0, 500, 0, '100.0%'],
    [2, 1, 0, '33.3%'],
    [0, 0, 100, '0.0%'],
    [0, 0, 0, '—'],
  ] as const)(
    'formats input=%d, cache read=%d, cache write=%d as %s',
    (inputTokens, cacheRead, cacheWrite, expected) => {
      expect(
        formatCacheHitRate({
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheWrite,
        }),
      ).toBe(expected)
    },
  )
})

describe('usage timing formatting', () => {
  test.each([null, undefined, NaN, Infinity, -1])(
    'omits invalid timing: %s',
    (value) => {
      expect(formatLatency(value)).toBe('—')
      expect(formatOutputSpeed(value)).toBe('—')
    },
  )
  test('formats millisecond and second latency, zero and token rates', () => {
    expect(formatLatency(0)).toBe('0 ms')
    expect(formatLatency(124.8)).toBe('125 ms')
    expect(formatLatency(1250)).toBe('1.25 s')
    expect(formatOutputSpeed(42.567)).toBe('42.6 tok/s')
    expect(formatOutputSpeed(0)).toBe('0.0 tok/s')
  })
})
