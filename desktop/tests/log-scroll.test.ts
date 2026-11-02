import { describe, expect, test } from 'bun:test'

import {
  LOG_FOLLOW_THRESHOLD_PX,
  decideLogFollowScroll,
  distanceFromLogBottom,
  maxLogScrollTop,
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

  test('stays pinned inside the follow band and lets a real scroll-up detach', () => {
    expect(LOG_FOLLOW_THRESHOLD_PX).toBe(80)
    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 740, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 800,
        pinTarget: null,
      }).follow,
    ).toBe(true)

    const detached = decideLogFollowScroll({
      follow: true,
      metrics: { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 },
      previousScrollTop: 800,
      pinTarget: null,
    })
    expect(detached).toEqual({ follow: false, pinTarget: null })

    expect(
      decideLogFollowScroll({
        follow: false,
        metrics: { scrollTop: 750, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 400,
        pinTarget: null,
      }).follow,
    ).toBe(true)

    expect(
      decideLogFollowScroll({
        follow: false,
        metrics: { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 200,
        pinTarget: null,
      }),
    ).toEqual({ follow: false, pinTarget: null })
  })

  test('ignores a one-pixel jitter and growth that does not move the viewport', () => {
    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 799, scrollHeight: 1000, clientHeight: 100 },
        previousScrollTop: 800,
        pinTarget: null,
      }).follow,
    ).toBe(true)
    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 100, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 100,
        pinTarget: null,
      }).follow,
    ).toBe(true)
  })

  test('tracks a pin and only detaches when the reader leaves it', () => {
    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 250,
        pinTarget: 800,
      }),
    ).toEqual({ follow: true, pinTarget: 800 })

    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 700,
        pinTarget: 800,
      }),
    ).toEqual({ follow: true, pinTarget: null })

    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 300, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 500,
        pinTarget: 800,
      }),
    ).toEqual({ follow: false, pinTarget: null })

    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 102, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 101,
        pinTarget: 100,
      }),
    ).toEqual({ follow: true, pinTarget: 100 })

    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 40, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 100,
        pinTarget: 100,
      }),
    ).toEqual({ follow: false, pinTarget: null })
    expect(
      decideLogFollowScroll({
        follow: true,
        metrics: { scrollTop: 400, scrollHeight: 1000, clientHeight: 200 },
        previousScrollTop: 100,
        pinTarget: 100,
      }),
    ).toEqual({ follow: true, pinTarget: null })
  })
})
