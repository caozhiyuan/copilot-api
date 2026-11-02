import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import {
  BoundedLogBuffer,
  LOG_UPDATE_INTERVAL_MS,
  truncateLogText,
} from '../../shared/log-buffer'
import type { ServerLogRecord } from '../types/ipc'
import {
  LOG_SCROLL_EPSILON_PX,
  decideLogFollowScroll,
  logPinBehavior,
  maxLogScrollTop,
  type ProgrammaticLogScroll,
} from './log-scroll'

/** Evicting rows must not move the viewport through scroll anchoring. */
const noScrollAnchor = { overflowAnchor: 'none' } as const

interface LogAnchor {
  sequence: string
  contentTop: number
}

function normalizeHistory(
  history: Array<ServerLogRecord>,
): Array<ServerLogRecord> {
  return history.flatMap((log) => {
    const normalized = truncateLogText(log.text)
    return normalized.length > 0 ? [{ ...log, text: normalized }] : []
  })
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function rowContentTop(scroller: HTMLElement, row: HTMLElement): number {
  return (
    row.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top
    + scroller.scrollTop
  )
}

function captureLogAnchor(scroller: HTMLElement): LogAnchor | null {
  const rect = scroller.getBoundingClientRect()
  if (
    rect.height <= 0
    || rect.width <= 0
    || typeof document.elementFromPoint !== 'function'
  ) {
    return null
  }

  const hit = document.elementFromPoint(rect.left + 4, rect.top + 4)
  const row = hit?.closest<HTMLElement>('[data-log-sequence]')
  const sequence = row?.dataset.logSequence
  if (!row || !sequence || !scroller.contains(row) || !/^\d+$/.test(sequence)) {
    return null
  }

  return { sequence, contentTop: rowContentTop(scroller, row) }
}

function anchoredScrollTop(
  scroller: HTMLElement,
  anchor: LogAnchor,
): number | null {
  const row = scroller.querySelector<HTMLElement>(
    `[data-log-sequence="${anchor.sequence}"]`,
  )
  if (!row) return null
  const nextTop =
    scroller.scrollTop + (rowContentTop(scroller, row) - anchor.contentTop)
  return Math.min(maxLogScrollTop(scroller), Math.max(0, nextTop))
}

function usePinnedLogScroll(logs: ReadonlyArray<unknown>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const previousScrollTopRef = useRef(0)
  const programmaticRef = useRef<ProgrammaticLogScroll | null>(null)
  const applyingRef = useRef(false)
  const anchorRef = useRef<LogAnchor | null>(null)

  const pinToBottom = () => {
    const node = scrollRef.current
    if (!node || !followRef.current) return

    const top = maxLogScrollTop(node)
    const distance = top - node.scrollTop
    if (distance <= LOG_SCROLL_EPSILON_PX) {
      programmaticRef.current = null
      previousScrollTopRef.current = node.scrollTop
      return
    }

    const inFlight = programmaticRef.current
    if (inFlight && Math.abs(inFlight.top - top) <= LOG_SCROLL_EPSILON_PX)
      return

    const behavior = logPinBehavior({
      distance,
      programmaticInFlight: inFlight !== null,
      reduceMotion: prefersReducedMotion(),
    })
    programmaticRef.current = { top, lastTop: node.scrollTop }
    applyingRef.current = true
    try {
      node.scrollTo({ top, behavior })
    } finally {
      applyingRef.current = false
    }
    previousScrollTopRef.current = node.scrollTop
    if (Math.abs(node.scrollTop - top) <= LOG_SCROLL_EPSILON_PX) {
      programmaticRef.current = null
    }
  }

  const restoreAnchor = () => {
    const node = scrollRef.current
    const anchor = anchorRef.current
    if (!node || !anchor || followRef.current) return

    const top = anchoredScrollTop(node, anchor)
    if (
      top === null
      || Math.abs(top - node.scrollTop) <= LOG_SCROLL_EPSILON_PX
    ) {
      return
    }

    applyingRef.current = true
    programmaticRef.current = null
    try {
      node.scrollTo({ top, behavior: 'auto' })
    } finally {
      applyingRef.current = false
    }
    previousScrollTopRef.current = node.scrollTop
  }

  useLayoutEffect(() => {
    restoreAnchor()
    pinToBottom()
    const node = scrollRef.current
    anchorRef.current =
      node && !followRef.current ? captureLogAnchor(node) : null
  }, [logs])

  const onScroll = () => {
    const node = scrollRef.current
    if (!node || applyingRef.current) return

    const wasFollowing = followRef.current
    const hadProgrammatic = programmaticRef.current !== null
    const decision = decideLogFollowScroll({
      follow: wasFollowing,
      metrics: {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      },
      previousScrollTop: previousScrollTopRef.current,
      programmatic: programmaticRef.current,
    })
    followRef.current = decision.follow
    previousScrollTopRef.current = decision.previousScrollTop
    programmaticRef.current = decision.programmatic

    if (wasFollowing && !decision.follow) {
      if (hadProgrammatic) {
        applyingRef.current = true
        programmaticRef.current = null
        try {
          node.scrollTo({ top: node.scrollTop, behavior: 'auto' })
        } finally {
          applyingRef.current = false
        }
        previousScrollTopRef.current = node.scrollTop
      }
      anchorRef.current = captureLogAnchor(node)
      return
    }

    if (!wasFollowing && decision.follow) {
      anchorRef.current = null
      pinToBottom()
      return
    }

    anchorRef.current = decision.follow ? null : captureLogAnchor(node)
  }

  const enableFollow = () => {
    followRef.current = true
    anchorRef.current = null
    programmaticRef.current = null
  }

  return { scrollRef, onScroll, enableFollow }
}

function LogScroller({
  className,
  onScroll,
  scrollRef,
  children,
}: {
  className: string
  onScroll: () => void
  scrollRef: RefObject<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={className}
      style={noScrollAnchor}
    >
      {children}
    </div>
  )
}

export default function ServerLogPanel({
  variant,
}: {
  variant: 'failure' | 'page'
}) {
  const { t } = useLanguage()
  const [logs, setLogs] = useState<Array<ServerLogRecord>>([])
  const [ready, setReady] = useState(false)
  const bufferRef = useRef(
    new BoundedLogBuffer<ServerLogRecord>((log) => log.text),
  )
  const publishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { scrollRef, onScroll, enableFollow } = usePinnedLogScroll(logs)

  useEffect(() => {
    let active = true
    let replayReady = false
    const pendingLive = new BoundedLogBuffer<ServerLogRecord>((log) => log.text)

    const publish = () => {
      publishTimerRef.current = null
      setLogs(bufferRef.current.values())
    }
    const schedulePublish = () => {
      if (publishTimerRef.current !== null) return
      publishTimerRef.current = setTimeout(publish, LOG_UPDATE_INTERVAL_MS)
    }
    const append = (log: ServerLogRecord) => {
      const normalized = truncateLogText(log.text)
      if (!active || normalized.length === 0) return
      const normalizedLog = { ...log, text: normalized }
      if (!replayReady) {
        pendingLive.append(normalizedLog)
        return
      }

      bufferRef.current.append(normalizedLog)
      schedulePublish()
    }

    const unsubscribe = window.electronAPI.onServerLog(append)
    void window.electronAPI
      .getLogs()
      .then((rawHistory) => {
        if (!active) return
        const history = normalizeHistory(rawHistory)
        const watermark = history.at(-1)?.sequence ?? 0
        const live = pendingLive
          .values()
          .filter((log) => log.sequence > watermark)
        bufferRef.current.clear()
        for (const log of [...history, ...live]) bufferRef.current.append(log)
        pendingLive.clear()
        replayReady = true
        setReady(true)
        publish()
      })
      .catch(() => {
        if (!active) return
        for (const log of pendingLive.values()) bufferRef.current.append(log)
        pendingLive.clear()
        replayReady = true
        setReady(true)
        publish()
      })

    return () => {
      active = false
      unsubscribe()
      if (publishTimerRef.current !== null) {
        clearTimeout(publishTimerRef.current)
        publishTimerRef.current = null
      }
    }
  }, [])

  const clearLogs = () => {
    void window.electronAPI
      .clearLogs()
      .then((watermark) => {
        if (publishTimerRef.current !== null) {
          clearTimeout(publishTimerRef.current)
          publishTimerRef.current = null
        }
        const kept = bufferRef.current
          .values()
          .filter((log) => log.sequence > watermark)
        bufferRef.current.clear()
        for (const log of kept) bufferRef.current.append(log)
        enableFollow()
        setLogs(bufferRef.current.values())
      })
      .catch(() => {})
  }

  const content = (
    <>
      {!ready ?
        <span className="text-ink-faint" style={noScrollAnchor}>
          {t('dashboard.loading')}
        </span>
      : logs.length === 0 ?
        <span className="text-ink-soft" style={noScrollAnchor}>
          {t('dashboard.noLogs')}
        </span>
      : logs.map((log) => (
          <div
            key={log.sequence}
            data-log-sequence={log.sequence}
            className="whitespace-pre-wrap break-all"
            style={noScrollAnchor}
          >
            {log.text.trimEnd()}
          </div>
        ))
      }
    </>
  )

  if (variant === 'failure') {
    return (
      <div className="w-full max-w-2xl bg-black rounded-xl p-4 flex flex-col overflow-hidden min-h-0">
        <div className="flex items-center justify-between mb-3 shrink-0">
          <span className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
            {t('dashboard.serverLog')}
          </span>
        </div>
        <LogScroller
          scrollRef={scrollRef}
          onScroll={onScroll}
          className="max-h-60 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed"
        >
          {content}
        </LogScroller>
      </div>
    )
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <div className="flex-1 bg-black rounded-xl p-4 flex flex-col overflow-hidden min-h-0">
        <div className="flex items-center justify-between mb-3 shrink-0">
          <span className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
            {t('dashboard.serverLog')}
          </span>
          <button
            type="button"
            onClick={clearLogs}
            disabled={!ready}
            className="text-[13px] text-ink-soft hover:text-ink-faint transition-colors disabled:opacity-40"
          >
            {t('dashboard.clear')}
          </button>
        </div>
        <LogScroller
          scrollRef={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed"
        >
          {content}
        </LogScroller>
      </div>
    </div>
  )
}
