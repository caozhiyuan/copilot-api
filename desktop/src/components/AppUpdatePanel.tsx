import { useEffect, useState } from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import type { AppUpdateStatus } from '../types/ipc'

export default function AppUpdatePanel({
  compact = false,
  checkOnMount = false,
}: {
  compact?: boolean
  checkOnMount?: boolean
}) {
  const { t } = useLanguage()
  const [status, setStatus] = useState<AppUpdateStatus | null>(null)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    let active = true
    let statusRevision = 0
    const unsubscribe = window.electronAPI.onAppUpdateStatus((next) => {
      statusRevision += 1
      if (active) setStatus(next)
    })
    void window.electronAPI
      .getAppUpdateStatus()
      .then(async (initial) => {
        if (active && statusRevision === 0) setStatus(initial)
        if (active && checkOnMount) {
          const checkRevision = statusRevision
          const checked = await window.electronAPI.checkAppUpdate()
          if (active && statusRevision === checkRevision) setStatus(checked)
        }
      })
      .catch(() => {
        if (active) setActionError(t('updates.actionFailed'))
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [checkOnMount])

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError('')
    try {
      await action()
    } catch {
      setActionError(t('updates.actionFailed'))
    }
  }

  if (
    compact
    && (!status
      || !['available', 'downloading', 'downloaded', 'installing'].includes(
        status.phase,
      ))
  )
    return null

  const busy =
    status?.phase === 'checking'
    || status?.phase === 'downloading'
    || status?.phase === 'installing'
  const buttonClass =
    'shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-sunken disabled:opacity-50'

  return (
    <div
      className={
        compact ?
          'shrink-0 border-b border-line-soft bg-surface px-5 py-2'
        : 'space-y-3'
      }
    >
      {!compact && (
        <>
          <h2 className="text-[13px] font-semibold text-ink">
            {t('updates.title')}
          </h2>
          <p className="text-[12px] leading-relaxed text-ink-faint">
            {t('updates.description')}
          </p>
          <p className="text-[12px] text-ink-soft">
            {t('updates.currentVersion', {
              version: status?.currentVersion ?? '…',
            })}
          </p>
        </>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-[12px] text-ink-soft" aria-live="polite">
          {(
            status?.phase === 'downloaded'
            && status.packageReady
            && status.manualInstall
          ) ?
            t('updates.packageReady', { version: status.version ?? '' })
          : status
            && t(`updates.${status.phase}`, {
              version: status.version ?? '',
              percent: Math.round(status.percent ?? 0),
            })
          }
          {status?.phase === 'available' && status.manualInstall && (
            <p className="mt-1 text-ink-faint">{t('updates.manualInstall')}</p>
          )}
        </div>
        {status?.phase === 'downloaded' ?
          <div className="flex shrink-0 items-center gap-2">
            {!status.manualInstall && (
              <button
                className={buttonClass}
                onClick={() =>
                  void runAction(() => window.electronAPI.installAppUpdate())
                }
              >
                {t('updates.restartInstall')}
              </button>
            )}
            {status.packageReady && (
              <>
                <button
                  className={buttonClass}
                  onClick={() =>
                    void runAction(() =>
                      window.electronAPI.openAppUpdatePackage(true),
                    )
                  }
                >
                  {t('updates.showPackage')}
                </button>
                {!compact && (
                  <button
                    className={buttonClass}
                    onClick={() =>
                      void runAction(() =>
                        window.electronAPI.openAppUpdatePackage(),
                      )
                    }
                  >
                    {t('updates.openPackage')}
                  </button>
                )}
              </>
            )}
          </div>
        : status?.phase === 'available' && status.manualInstall ?
          <button
            className={buttonClass}
            onClick={() =>
              void runAction(() =>
                window.electronAPI.openUrl(status.releaseUrl),
              )
            }
          >
            {t('updates.openRelease')}
          </button>
        : !compact && (
            <button
              className={buttonClass}
              disabled={!status || busy || status.phase === 'disabled'}
              onClick={() =>
                void runAction(() => window.electronAPI.checkAppUpdate())
              }
            >
              {t('updates.check')}
            </button>
          )
        }
      </div>
      {status?.phase === 'downloading' && (
        <progress
          className="mt-2 h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-sunken [&::-webkit-progress-value]:bg-accent dark:[&::-webkit-progress-value]:bg-blue-500"
          aria-label={t('updates.progress')}
          max={100}
          value={status.percent ?? 0}
        />
      )}
      {!compact && status?.phase === 'downloaded' && (
        <p className="text-[12px] text-ink-faint">
          {t(
            status.packageReady && status.manualInstall ?
              'updates.manualPackageNote'
            : 'updates.restartNote',
          )}
        </p>
      )}
      {(actionError || status?.error) && (
        <p role="alert" className="mt-2 break-words text-[12px] text-red-500">
          {actionError || status?.error}
        </p>
      )}
    </div>
  )
}
