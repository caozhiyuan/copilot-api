import { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import {
  BoundedLogBuffer,
  LOG_UPDATE_INTERVAL_MS,
  truncateLogText,
} from '../../shared/log-buffer'
import type { ServerLogRecord } from '../types/ipc'

function normalizeHistory(
  history: Array<ServerLogRecord>,
): Array<ServerLogRecord> {
  return history.flatMap((log) => {
    const normalized = truncateLogText(log.text)
    return normalized.length > 0 ? [{ ...log, text: normalized }] : []
  })
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const logEndRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)

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

  useEffect(() => {
    if (followRef.current) logEndRef.current?.scrollIntoView()
  }, [logs])

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
        setLogs(bufferRef.current.values())
        followRef.current = true
      })
      .catch(() => {})
  }

  const content = (
    <>
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
      <div ref={logEndRef} />
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
        <div
          ref={scrollRef}
          onScroll={() => {
            const node = scrollRef.current
            if (!node) return
            followRef.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 24
          }}
          className="max-h-60 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed"
        >
          {content}
        </div>
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
        <div
          ref={scrollRef}
          onScroll={() => {
            const node = scrollRef.current
            if (!node) return
            followRef.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 24
          }}
          className="flex-1 overflow-y-auto font-mono text-[13px] text-green-400 space-y-0.5 leading-relaxed"
        >
          {content}
        </div>
      </div>
    </div>
  )
}
