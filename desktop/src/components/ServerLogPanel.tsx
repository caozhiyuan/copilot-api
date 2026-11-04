import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import { mergeServerLogs } from '../../shared/server-logs'
import type { ServerLogRecord } from '../types/ipc'

function usePinnedLogScroll(logs: ReadonlyArray<unknown>, ready: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

  const pinToBottom = () => {
    const node = scrollRef.current
    if (node && followRef.current) {
      // Live output follows immediately; restarting smooth animations can lag
      // indefinitely while the scroll height keeps growing.
      node.scrollTo({ top: node.scrollHeight, behavior: 'instant' })
    }
  }

  useLayoutEffect(() => {
    pinToBottom()
  }, [logs, ready])

  const onScroll = () => {
    const node = scrollRef.current
    if (!node) return

    const wasFollowing = followRef.current
    followRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight <= 80
    if (!wasFollowing && followRef.current) pinToBottom()
  }

  const enableFollow = () => {
    followRef.current = true
    pinToBottom()
  }

  return { scrollRef, onScroll, enableFollow }
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

  const isPage = variant === 'page'
  const panel = (
    <div
      className={`${isPage ? 'flex-1' : 'w-full max-w-2xl'} bg-black rounded-xl p-4 flex flex-col overflow-hidden min-h-0`}
    >
      <div className="flex items-center justify-between mb-3 shrink-0">
        <span className="text-[13px] font-semibold text-ink-faint uppercase tracking-wide">
          {t('dashboard.serverLog')}
        </span>
        {isPage && (
          <button
            type="button"
            onClick={clearLogs}
            disabled={!ready}
            className="text-[13px] text-ink-soft hover:text-ink-faint transition-colors disabled:opacity-40"
          >
            {t('dashboard.clear')}
          </button>
        )}
      </div>
      {/* Native scroll anchoring keeps the visible rows in place when older
          entries are evicted while the reader has stopped following. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`${isPage ? 'flex-1' : 'max-h-60'} overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed`}
      >
        {!ready ?
          <span className="text-ink-faint">{t('dashboard.loading')}</span>
        : logs.length === 0 ?
          <span className="text-ink-soft">{t('dashboard.noLogs')}</span>
        : logs.map((log) => (
            <div key={log.sequence} className="whitespace-pre-wrap break-all">
              {log.text.trimEnd()}
            </div>
          ))
        }
      </div>
    </div>
  )

  return isPage ?
      <div className="p-4 h-full flex flex-col">{panel}</div>
    : panel
}
