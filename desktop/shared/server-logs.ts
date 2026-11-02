/** Console lines kept for the desktop log panel. Older lines are dropped. */
export const MAX_SERVER_LOG_ENTRIES = 2_000

interface SequencedLog {
  sequence: number
  text: string
}

export function appendServerLog<T>(logs: T[], entry: T): void {
  logs.push(entry)
  const overflow = logs.length - MAX_SERVER_LOG_ENTRIES
  if (overflow > 0) logs.splice(0, overflow)
}

/**
 * Merge history with lines that arrived early, drop anything at or below a
 * clear watermark, and keep the newest capped entries in sequence order.
 */
export function mergeServerLogs<T extends SequencedLog>(
  current: readonly T[],
  incoming: readonly T[],
  clearedThrough = 0,
): T[] {
  const bySequence = new Map<number, T>()
  for (const log of current) remember(bySequence, log, clearedThrough)
  for (const log of incoming) remember(bySequence, log, clearedThrough)

  const merged = [...bySequence.values()].sort(
    (left, right) => left.sequence - right.sequence,
  )
  const capped =
    merged.length > MAX_SERVER_LOG_ENTRIES ?
      merged.slice(merged.length - MAX_SERVER_LOG_ENTRIES)
    : merged

  if (
    capped.length === current.length
    && capped.every(
      (log, index) =>
        log.sequence === current[index]?.sequence
        && log.text === current[index]?.text,
    )
  ) {
    return current as T[]
  }
  return capped
}

function remember<T extends SequencedLog>(
  bySequence: Map<number, T>,
  log: T,
  clearedThrough: number,
): void {
  if (log.sequence <= clearedThrough || log.text.length === 0) return
  bySequence.set(log.sequence, log)
}
