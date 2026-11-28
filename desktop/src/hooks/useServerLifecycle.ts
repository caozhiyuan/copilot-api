import { useEffect, useRef, useState } from 'react'
import { buildServerBaseUrl } from '../lib/server-url'
import type { LocaleKey } from '../locales'
import type { ServerAuthInfo, ServerStatus } from '../types/ipc'

type TranslateFn = (
  key: LocaleKey,
  vars?: Record<string, string | number>,
) => string

interface UseServerLifecycleOptions {
  defaultHost: string
  defaultPort: number
  initialServerStatus?: ServerStatus
  onServerStopped: () => void
  t: TranslateFn
}

export function useServerLifecycle({
  defaultHost,
  defaultPort,
  initialServerStatus,
  onServerStopped,
  t,
}: UseServerLifecycleOptions) {
  const tRef = useRef(t)
  tRef.current = t
  const onServerStoppedRef = useRef(onServerStopped)
  onServerStoppedRef.current = onServerStopped

  const [started, setStarted] = useState(initialServerStatus?.running ?? false)
  const [port, setPort] = useState<string>(
    String(initialServerStatus?.port ?? defaultPort),
  )
  const [host, setHost] = useState<string>(
    initialServerStatus?.host ?? defaultHost,
  )
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(
    initialServerStatus && !initialServerStatus.running ?
      (initialServerStatus.error ?? t('dashboard.serverUnexpectedStop'))
    : '',
  )
  const [stopping, setStopping] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [serverError, setServerError] = useState('')
  const [serverAuthInfo, setServerAuthInfo] = useState<ServerAuthInfo>({
    enabled: false,
  })
  const [logPanelSession, setLogPanelSession] = useState(0)

  const intentionalStop = useRef(false)
  const wasRestarting = useRef(false)

  // Keep the live log subscription open while restarting, then load the new
  // process's history when the restart finishes.
  useEffect(() => {
    if (wasRestarting.current && !restarting) {
      setLogPanelSession((session) => session + 1)
    }
    wasRestarting.current = restarting
  }, [restarting])

  useEffect(() => {
    let active = true

    window.electronAPI
      .getServerStatus()
      .then((status) => {
        if (!active) return
        // Only a running server reports the host and port it actually bound,
        // so an idle status must not overwrite the saved settings.
        if (status.running) {
          if (status.port) setPort(String(status.port))
          if (status.host !== undefined) setHost(status.host)
        }
        setStarted(status.running)
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [])

  // Watch server status changes and only surface unexpected stops.
  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerStatus((status) => {
      if (status.restarting) {
        setRestarting(true)
        setStartError('')
        setServerError('')
        return
      }
      if (status.running) {
        setRestarting(false)
        if (status.port) setPort(String(status.port))
        if (status.host !== undefined) setHost(status.host)
        setStarted(true)
        setServerError('')
        intentionalStop.current = false
        return
      }
      if (!status.running) {
        if (!intentionalStop.current) {
          setRestarting(false)
          setServerError(
            status.error
              ?? (status.intentional ? '' : (
                tRef.current('dashboard.serverUnexpectedStop')
              )),
          )
          setStarted(false)
        }
        intentionalStop.current = false
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!started) {
      setServerAuthInfo({ enabled: false })
      return
    }
    if (restarting) return

    window.electronAPI
      .getServerAuthInfo()
      .then(setServerAuthInfo)
      .catch(() => {
        setServerAuthInfo({ enabled: false })
      })
  }, [started, restarting])

  const portNum = parseInt(port, 10)
  const normalizedHost = host.trim()
  const openaiUrl = `${buildServerBaseUrl(host, portNum)}/v1`
  const anthropicUrl = buildServerBaseUrl(host, portNum)
  const shouldShowFailureLogs = !started && Boolean(startError || serverError)

  const refreshAuthMode = async () => {
    const status = await window.electronAPI.getAuthStatus()
    return status.mode
  }

  const handleStart = async () => {
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setStartError(t('dashboard.invalidPort'))
      return
    }
    setStarting(true)
    setStartError('')
    setServerError('')
    try {
      const status = await window.electronAPI.startServer(
        portNum,
        await refreshAuthMode(),
        normalizedHost,
      )
      if (status.running) {
        setStarted(true)
      } else {
        setStartError(status.error ?? t('dashboard.serverUnexpectedStop'))
      }
    } catch (err) {
      setStartError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const handleStop = async () => {
    intentionalStop.current = true
    setStopping(true)
    await window.electronAPI.stopServer()
    setStopping(false)
    setStarted(false)
    onServerStoppedRef.current()
    setServerError('')
  }

  const handleRestart = async () => {
    if (Number.isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setStartError(t('dashboard.invalidPort'))
      return
    }

    intentionalStop.current = true
    setRestarting(true)
    setStartError('')
    setServerError('')
    try {
      await window.electronAPI.stopServer()
      const status = await window.electronAPI.startServer(
        portNum,
        await refreshAuthMode(),
        normalizedHost,
      )
      if (status.running) {
        if (status.port) setPort(String(status.port))
        if (status.host !== undefined) setHost(status.host)
        setStarted(true)
      } else {
        setStarted(false)
        onServerStoppedRef.current()
        setStartError(status.error ?? t('dashboard.serverUnexpectedStop'))
      }
    } catch (err) {
      setStarted(false)
      setStartError((err as Error).message)
    } finally {
      setRestarting(false)
    }
  }

  return {
    anthropicUrl,
    handleRestart,
    handleStart,
    handleStop,
    host,
    logPanelSession,
    openaiUrl,
    port,
    portNum,
    restarting,
    serverAuthInfo,
    serverError,
    setHost,
    setPort,
    setStartError,
    shouldShowFailureLogs,
    started,
    startError,
    starting,
    stopping,
  }
}
