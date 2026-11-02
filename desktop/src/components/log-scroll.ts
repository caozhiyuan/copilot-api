/** Re-pin when the reader is within this distance of the newest line. */
export const LOG_FOLLOW_THRESHOLD_PX = 80

export const LOG_SCROLL_EPSILON_PX = 1

export interface LogScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function distanceFromLogBottom(metrics: LogScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

export function maxLogScrollTop(
  metrics: Pick<LogScrollMetrics, 'scrollHeight' | 'clientHeight'>,
): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight)
}

/**
 * Follow mode changes only when the reader moves the viewport.
 * Events that continue toward the current pin keep the current mode, so a
 * smooth scroll to the bottom cannot turn follow off before it arrives.
 */
export function decideLogFollowScroll(input: {
  follow: boolean
  metrics: LogScrollMetrics
  previousScrollTop: number
  pinTarget: number | null
}): { follow: boolean; pinTarget: number | null } {
  const distance = distanceFromLogBottom(input.metrics)
  const nearBottom = distance <= LOG_FOLLOW_THRESHOLD_PX
  const delta = input.metrics.scrollTop - input.previousScrollTop

  if (
    input.pinTarget !== null
    && Math.abs(input.metrics.scrollTop - input.pinTarget)
      > LOG_SCROLL_EPSILON_PX
    && movesTowardPin(input.pinTarget, input.previousScrollTop, delta)
  ) {
    return { follow: input.follow, pinTarget: input.pinTarget }
  }

  if (nearBottom) return { follow: true, pinTarget: null }
  if (delta < -LOG_SCROLL_EPSILON_PX) return { follow: false, pinTarget: null }
  return { follow: input.follow, pinTarget: null }
}

function movesTowardPin(
  pinTarget: number,
  previousScrollTop: number,
  delta: number,
): boolean {
  const targetDelta = pinTarget - previousScrollTop
  if (Math.abs(targetDelta) <= LOG_SCROLL_EPSILON_PX) {
    return Math.abs(delta) <= LOG_SCROLL_EPSILON_PX
  }
  return delta * Math.sign(targetDelta) >= -LOG_SCROLL_EPSILON_PX
}
