import { describe, expect, test } from 'bun:test'

import {
  decideLogFollowScroll,
  distanceFromLogBottom,
  logPinBehavior,
  maxLogScrollTop,
  scrollTopKeepingAnchor,
} from '../src/components/log-scroll'

describe('log scroll follow', () => {
  test('measures the gap below the viewport', () => {
    expect(
      distanceFromLogBottom({
        scrollTop: 40,
        scrollHeight: 200,
        clientHeight: 50,
      }),
    ).toBe(110)
    expect(
      maxLogScrollTop({
        scrollHeight: 80,
        clientHeight: 200,
      }),
    ).toBe(0)
  })

  test('glides a short catch-up and snaps a long or interrupted one', () => {
    expect(
      logPinBehavior({
        distance: 100,
        programmaticInFlight: false,
        reduceMotion: false,
      }),
    ).toBe('smooth')
    expect(
      logPinBehavior({
        distance: 161,
        programmaticInFlight: false,
        reduceMotion: false,
      }),
    ).toBe('auto')
    expect(
      logPinBehavior({
        distance: 40,
        programmaticInFlight: true,
        reduceMotion: false,
      }),
    ).toBe('auto')
    expect(
      logPinBehavior({
        distance: 40,
        programmaticInFlight: false,
        reduceMotion: true,
      }),
    ).toBe('auto')
  })

  test('shifts scrollTop with an anchored row', () => {
    expect(
      scrollTopKeepingAnchor({
        scrollTop: 200,
        previousRowTop: 240,
        nextRowTop: 210,
      }),
    ).toBe(170)
  })

  test('stays pinned inside the follow band and lets a real scroll-up detach', () => {
    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 740, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 800,
        programmatic: null,
      }).follow,
    ).toBe(true)

    const detached = decideLogFollowScroll({
      follow: true,
      metrics: { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 },
      previousScrollTop: 800,
      programmatic: null,
    })
    expect(detached.follow).toBe(false)
    expect(detached.previousScrollTop).toBe(500)

    expect(
      decideLogFollowScroll({
        follow: false,
        metrics: { scrollTop: 750, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 400,
        programmatic: null,
      }).follow,
    ).toBe(true)

    expect(
      decideLogFollowScroll({
        follow: false,
        metrics: { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 200,
        programmatic: null,
      }).follow,
    ).toBe(false)
  })

  test('ignores growth that does not move the viewport', () => {
    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 100, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 100,
        programmatic: null,
      }).follow,
    ).toBe(true)
  })

  test('tracks a programmatic glide and only detaches when it reverses', () => {
    const moving = decideLogFollowScroll({
      follow: true,
      metrics: { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 },
      previousScrollTop: 250,
      programmatic: { top: 800, lastTop: 250 },
    })
    expect(moving.follow).toBe(true)
    expect(moving.programmatic).toEqual({ top: 800, lastTop: 400 })

    const arrived = decideLogFollowScroll({
      follow: true,
      metrics: { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 },
      previousScrollTop: 700,
      programmatic: { top: 800, lastTop: 700 },
    })
    expect(arrived.follow).toBe(true)
    expect(arrived.programmatic).toBeNull()

    const reversed = decideLogFollowScroll({
      follow: true,
      metrics: { scrollTop: 300, scrollHeight: 1000, clientHeight: 200 },
      previousScrollTop: 500,
      programmatic: { top: 800, lastTop: 500 },
    })
    expect(reversed.follow).toBe(false)
    expect(reversed.programmatic).toBeNull()

    const clamped = decideLogFollowScroll({
      follow: true,
      metrics: { scrollTop: 700, scrollHeight: 900, clientHeight: 200 },
      previousScrollTop: 800,
      programmatic: { top: 1000, lastTop: 800 },
    })
    expect(clamped.follow).toBe(true)
    expect(clamped.programmatic).toBeNull()
  })
})
