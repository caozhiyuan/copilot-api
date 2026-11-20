import type { AuthTranslateFn } from './auth-constants'

interface DeviceCodePendingCardProps {
  copied: boolean
  deviceCode: { user_code: string; verification_uri: string } | null
  mode: 'oauth-pending' | 'xai-pending'
  oauthCancelling: boolean
  oauthSaving: boolean
  onBack: () => void
  onCancel: () => void
  onCopyCode: () => void
  onOpenDeviceUrl: () => void
  polling: boolean
  t: AuthTranslateFn
}

export function DeviceCodePendingCard({
  copied,
  deviceCode,
  mode,
  oauthCancelling,
  oauthSaving,
  onBack,
  onCancel,
  onCopyCode,
  onOpenDeviceUrl,
  polling,
  t,
}: DeviceCodePendingCardProps) {
  return (
    <div className="w-full max-w-[320px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
      {deviceCode && !oauthSaving && (
        <>
          <div>
            <p className="text-[13px] text-ink-faint mb-1.5">
              {t('auth.deviceCode')}
            </p>
            <div className="flex items-center gap-2 px-3 py-2.5 border border-dashed border-line rounded-lg bg-sunken">
              <span className="font-mono text-[13px] font-bold text-ink tracking-widest flex-1">
                {deviceCode.user_code}
              </span>
              <button
                onClick={onCopyCode}
                className="text-[13px] text-accent hover:text-accent/80 shrink-0"
              >
                {copied ? t('auth.copied') : t('auth.copy')}
              </button>
            </div>
          </div>
          <div>
            <p className="text-[13px] text-ink-faint mb-1.5">
              {t('auth.deviceCodeUrl')}
            </p>
            <button
              onClick={onOpenDeviceUrl}
              className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-left text-[13px] text-accent hover:text-accent/80 hover:bg-sunken transition-colors break-all"
            >
              {deviceCode.verification_uri}
            </button>
          </div>
          <button
            onClick={onOpenDeviceUrl}
            className="w-full py-2.5 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 transition-colors"
          >
            {t('auth.openAuthPage')}
          </button>
        </>
      )}
      {(polling || mode === 'xai-pending') && (
        <p className="text-center text-[13px] text-ink-faint animate-pulse">
          {mode === 'xai-pending' ?
            t(oauthSaving ? 'auth.verifying' : 'auth.waitingXaiAuth')
          : t('auth.waitingAuth')}
        </p>
      )}
      {mode === 'xai-pending' && (
        <button
          onClick={onCancel}
          disabled={oauthCancelling || oauthSaving}
          className="rounded-lg border border-line bg-surface py-2.5 text-[13px] font-semibold text-ink-soft hover:bg-sunken disabled:opacity-50"
        >
          {t(oauthCancelling ? 'auth.cancelling' : 'auth.cancelCodexAuth')}
        </button>
      )}
      <button
        onClick={onBack}
        disabled={oauthSaving || oauthCancelling}
        className="text-[13px] text-ink-faint hover:text-ink-soft text-center disabled:opacity-50"
      >
        {t('auth.back')}
      </button>
    </div>
  )
}

interface CodexPendingCardProps {
  authUrl: string
  copied: boolean
  oauthCancelling: boolean
  oauthSaving: boolean
  onBack: () => void
  onCancel: () => void
  onCopyUrl: () => void
  onOpenUrl: () => void
  t: AuthTranslateFn
}

export function CodexPendingCard({
  authUrl,
  copied,
  oauthCancelling,
  oauthSaving,
  onBack,
  onCancel,
  onCopyUrl,
  onOpenUrl,
  t,
}: CodexPendingCardProps) {
  return (
    <div className="w-full max-w-[440px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
      <p className="text-center text-[13px] text-ink-faint animate-pulse">
        {oauthSaving ?
          t('auth.codexFinishingAuth')
        : t('auth.waitingCodexAuth')}
      </p>
      {authUrl && !oauthSaving && (
        <>
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-faint">
            {t('auth.deviceCodeUrl')}
            <textarea
              readOnly
              rows={3}
              value={authUrl}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full resize-none rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[11px] text-ink-soft break-all"
            />
          </label>
          <button
            onClick={onOpenUrl}
            className="w-full rounded-lg bg-accent-strong py-2.5 text-[13px] font-semibold text-white hover:bg-accent-strong/90 transition-colors"
          >
            {t('auth.openAuthPage')}
          </button>
          <button
            onClick={onCopyUrl}
            className="w-full rounded-lg border border-line bg-surface py-2.5 text-[13px] font-semibold text-ink-soft hover:bg-sunken transition-colors"
          >
            {copied ? t('auth.copied') : t('auth.copy')}
          </button>
        </>
      )}
      <button
        onClick={onCancel}
        disabled={oauthCancelling || oauthSaving}
        className="w-full py-2.5 border border-line bg-surface text-ink-soft text-[13px] font-semibold rounded-lg hover:bg-sunken disabled:opacity-50 transition-colors"
      >
        {oauthCancelling ? t('auth.cancelling') : t('auth.cancelCodexAuth')}
      </button>
      <button
        onClick={onBack}
        className="text-[13px] text-ink-faint hover:text-ink-soft text-center"
      >
        {t('auth.back')}
      </button>
    </div>
  )
}
