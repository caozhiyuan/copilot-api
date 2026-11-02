import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import { mergeServerLogs } from '../../shared/server-logs'
import type { ServerLogRecord } from '../types/ipc'
import {
  LOG_SCROLL_EPSILON_PX,
  decideLogFollowScroll,
  maxLogScrollTop,
} from './log-scroll'

/** Evicting rows must not move the viewport through scroll anchoring. */
const noScrollAnchor = { overflowAnchor: 'none' } as const

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function usePinnedLogScroll(logs: ReadonlyArray<unknown>, ready: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const previousScrollTopRef = useRef(0)
  const pinTargetRef = useRef<number | null>(null)

  const pinToBottom = () => {
    const node = scrollRef.current
    if (!node || !followRef.current) return

    const top = maxLogScrollTop(node)
    if (Math.abs(node.scrollTop - top) <= LOG_SCROLL_EPSILON_PX) {
      pinTargetRef.current = null
      previousScrollTopRef.current = node.scrollTop
      return
    }
    if (
      pinTargetRef.current !== null
      && Math.abs(pinTargetRef.current - top) <= LOG_SCROLL_EPSILON_PX
    ) {
      return
    }

    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
    pinTargetRef.current = top
    node.scrollTo({ top, behavior })
    previousScrollTopRef.current = node.scrollTop
    if (Math.abs(node.scrollTop - top) <= LOG_SCROLL_EPSILON_PX) {
      pinTargetRef.current = null
    }
  }

  useLayoutEffect(() => {
    pinToBottom()
  }, [logs, ready])

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return

    const wasFollowing = followRef.current
    const hadPin = pinTargetRef.current !== null
    const decision = decideLogFollowScroll({
      follow: wasFollowing,
      metrics: {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      },
      previousScrollTop: previousScrollTopRef.current,
      pinTarget: pinTargetRef.current,
    })
    followRef.current = decision.follow
    pinTargetRef.current = decision.pinTarget
    previousScrollTopRef.current = node.scrollTop

    // Stop a glide that would otherwise pull the reader back to the tail.
    if (wasFollowing && !decision.follow && hadPin) {
      node.scrollTo({ top: node.scrollTop, behavior: 'auto' })
      return
    }
    if (!wasFollowing && decision.follow) pinToBottom()
  }

  const enableFollow = () => {
    followRef.current = true
    pinTargetRef.current = null
    pinToBottom()
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
  const clearedThroughRef = useRef(0)
  const { scrollRef, onScroll, enableFollow } = usePinnedLogScroll(logs, ready)

  useEffect(() => {
    let active = true
    const append = (incoming: Array<ServerLogRecord>) => {
      setLogs((current) =>
        mergeServerLogs(current, incoming, clearedThroughRef.current),
      )
    }

    const unsubscribe = window.electronAPI.onServerLog((log) => {
      if (active) append([log])
    })
    void window.electronAPI
      .getLogs()
      .then((history) => {
        if (!active) return
        append(history)
        setReady(true)
      })
      .catch(() => {
        if (active) setReady(true)
      })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const clearLogs = () => {
    void window.electronAPI
      .clearLogs()
      .then((watermark) => {
        // Lines at or below this sequence were discarded by the main process,
        // even when their event arrives after the clear click.
        clearedThroughRef.current = Math.max(
          clearedThroughRef.current,
          watermark,
        )
        enableFollow()
        setLogs((current) =>
          mergeServerLogs(current, [], clearedThroughRef.current),
        )
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
