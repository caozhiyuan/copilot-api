/** Re-pin when a user scroll finishes inside this distance of the newest line. */
export const LOG_FOLLOW_THRESHOLD_PX = 80

export const LOG_SCROLL_EPSILON_PX = 1

/**
 * Gaps larger than this snap to the tail. A smooth glide over a long distance
 * restarts on every batch and leaves the newest lines below the fold.
 */
export const LOG_SMOOTH_PIN_MAX_PX = 160

export interface LogScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Target of a pin the panel requested, plus the last scrollTop observed for it. */
export interface ProgrammaticLogScroll {
  top: number
  lastTop: number
}

export interface LogFollowScrollDecision {
  follow: boolean
  previousScrollTop: number
  programmatic: ProgrammaticLogScroll | null
}

export function distanceFromLogBottom(metrics: LogScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight
}

export function maxLogScrollTop(
  metrics: Pick<LogScrollMetrics, 'scrollHeight' | 'clientHeight'>,
): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight)
}

export function logPinBehavior(input: {
  distance: number
  programmaticInFlight: boolean
  reduceMotion: boolean
}): ScrollBehavior {
  if (
    input.reduceMotion
    || input.programmaticInFlight
    || input.distance > LOG_SMOOTH_PIN_MAX_PX
  ) {
    return 'auto'
  }
  return 'smooth'
}

/** Keep a row under the viewport when entries above it are evicted. */
export function scrollTopKeepingAnchor(input: {
  scrollTop: number
  previousRowTop: number
  nextRowTop: number
}): number {
  return input.scrollTop + (input.nextRowTop - input.previousRowTop)
}

/**
 * Follow mode changes only when the reader moves the viewport.
 * Scroll events that continue toward the last programmatic target stay on the
 * current follow mode, so a pin or a buffer eviction cannot stick the flag off.
 */
export function decideLogFollowScroll(input: {
  follow: boolean
  metrics: LogScrollMetrics
  previousScrollTop: number
  programmatic: ProgrammaticLogScroll | null
}): LogFollowScrollDecision {
  const distance = distanceFromLogBottom(input.metrics)
  const delta = input.metrics.scrollTop - input.previousScrollTop
  const movedUp = delta < -LOG_SCROLL_EPSILON_PX
  const nearBottom = distance <= LOG_FOLLOW_THRESHOLD_PX

  if (input.programmatic) {
    const programmatic = input.programmatic
    const remaining = Math.sign(programmatic.top - programmatic.lastTop)
    const reachedTarget =
      Math.abs(input.metrics.scrollTop - programmatic.top)
      <= LOG_SCROLL_EPSILON_PX
    if (reachedTarget) {
      return {
        follow: input.follow,
        previousScrollTop: input.metrics.scrollTop,
        programmatic: null,
      }
    }

    const towardTarget = delta * remaining >= -LOG_SCROLL_EPSILON_PX
    if (towardTarget) {
      return {
        follow: input.follow,
        previousScrollTop: input.metrics.scrollTop,
        programmatic: {
          top: programmatic.top,
          lastTop: input.metrics.scrollTop,
        },
      }
    }
  }

  let follow = input.follow
  if (nearBottom) follow = true
  else if (movedUp) follow = false

  return {
    follow,
    previousScrollTop: input.metrics.scrollTop,
    programmatic: null,
  }
}
