import { describe, expect, test } from 'bun:test'

import {
  MAX_SERVER_LOG_ENTRIES,
  appendServerLog,
  mergeServerLogs,
} from '../shared/server-logs'

function line(sequence: number, text = `line ${sequence}`) {
  return { sequence, text }
}

describe('server logs', () => {
  test('drops the oldest entries once the console cap is reached', () => {
    const logs: Array<ReturnType<typeof line>> = []
    appendServerLog(logs, line(1))
    expect(logs).toEqual([line(1)])

    for (let sequence = 2; sequence <= MAX_SERVER_LOG_ENTRIES; sequence += 1) {
      appendServerLog(logs, line(sequence))
    }
    expect(logs).toHaveLength(MAX_SERVER_LOG_ENTRIES)
    expect(logs[0]).toEqual(line(1))

    appendServerLog(logs, line(MAX_SERVER_LOG_ENTRIES + 1))
    expect(logs).toHaveLength(MAX_SERVER_LOG_ENTRIES)
    expect(logs[0]).toEqual(line(2))
    expect(logs.at(-1)).toEqual(line(MAX_SERVER_LOG_ENTRIES + 1))
  })

  test('merges early live lines with history without duplicating text', () => {
    const live = [
      line(2, 'shared log'),
      line(3, 'new live log'),
      line(4, 'shared log'),
    ]
    const merged = mergeServerLogs(live, [
      line(1, 'history log'),
      line(2, ''),
      line(2, 'shared log'),
    ])

    expect(merged.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4])
    expect(merged.filter((entry) => entry.text === 'shared log')).toHaveLength(
      2,
    )
  })

  test('drops lines at or below a clear watermark and keeps the same array when nothing changes', () => {
    const current = [line(1, 'old'), line(3, 'kept')]
    expect(mergeServerLogs(current, [line(1, 'old')], 2)).toEqual([
      line(3, 'kept'),
    ])
    expect(mergeServerLogs(current, [line(3, 'kept')])).toBe(current)
  })

  test('keeps only the newest capped lines when history and live lines overflow', () => {
    const current = Array.from({ length: MAX_SERVER_LOG_ENTRIES }, (_, index) =>
      line(index + 1),
    )
    const merged = mergeServerLogs(current, [line(MAX_SERVER_LOG_ENTRIES + 1)])

    expect(merged).toHaveLength(MAX_SERVER_LOG_ENTRIES)
    expect(merged[0]).toEqual(line(2))
    expect(merged.at(-1)).toEqual(line(MAX_SERVER_LOG_ENTRIES + 1))
  })
})
