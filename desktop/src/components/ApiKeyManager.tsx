import { useEffect, useState } from 'react'
import { isValidCostAmount } from '../../../src/lib/token-usage/currency'
import { primaryButtonClass } from '../lib/button-styles'
import { formatCostAmount } from '../lib/token-usage-format'
import { useLanguage } from '../contexts/LanguageContext'
import { resolveLanguage } from '../locales'
import type { ApiKeyQuotaUsage, GatewayApiKeyConfig } from '../types/ipc'
import ApiKeyExpiryPicker from './ApiKeyExpiryPicker'

function generateSecret(): string {
  return (
    'sk-'
    + Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('')
  )
}
function localExpiry(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}

export default function ApiKeyManager() {
  const { langPref, t } = useLanguage()
  const locale = resolveLanguage(langPref, navigator.language)
  const displayDateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  })
  const [keys, setKeys] = useState<GatewayApiKeyConfig[]>([])
  const [usage, setUsage] = useState<ApiKeyQuotaUsage[] | null>(null)
  const [draft, setDraft] = useState<GatewayApiKeyConfig | null>(null)
  const [expiry, setExpiry] = useState('')
  const [models, setModels] = useState('')
  const [restricted, setRestricted] = useState(false)
  const [period, setPeriod] = useState<'none' | 'day' | 'month' | 'lifetime'>(
    'none',
  )
  const [limit, setLimit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [usageIsolation, setUsageIsolation] = useState<boolean | null>(null)
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const [value, auth] = await Promise.all([
          window.electronAPI.getManagedApiKeys(),
          window.electronAPI.getServerKeys(),
        ])
        if (active) {
          setKeys(value)
          setUsageIsolation(auth.isolateApiKeyUsage === true)
        }
      } catch {
        if (active) setError(t('apiKeys.loadError'))
      }
    })()
    const refresh = async () => {
      try {
        const value = await window.electronAPI.getApiKeyQuotaUsage()
        if (active) setUsage(value)
      } catch {
        if (active) setUsage(null)
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [t])
  const saveUsageIsolation = async (enabled: boolean) => {
    setBusy(true)
    setError('')
    try {
      const saved = await window.electronAPI.saveServerKeys({
        isolateApiKeyUsage: enabled,
      })
      setUsageIsolation(saved.isolateApiKeyUsage === true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('apiKeys.saveError'))
    } finally {
      setBusy(false)
    }
  }
  const edit = (key: GatewayApiKeyConfig) => {
    setDraft({ ...key })
    setExpiry(localExpiry(key.expiresAt))
    setModels(key.allowedModels?.join('\n') ?? '')
    setRestricted(key.allowedModels !== undefined)
    setPeriod(key.quota?.period ?? 'none')
    setLimit(key.quota ? String(key.quota.amount) : '')
    setError('')
  }
  const save = async () => {
    if (!draft) return
    const amount = Number(limit)
    if (
      !draft.key.trim()
      || (period !== 'none' && (!limit.trim() || !isValidCostAmount(amount)))
    ) {
      setError(t('apiKeys.required'))
      return
    }
    let expiresAt = expiry ? draft.expiresAt : undefined
    if (expiry && expiry !== localExpiry(expiresAt)) {
      const date = new Date(expiry)
      const iso =
        Number.isFinite(date.getTime()) ? date.toISOString() : undefined
      if (!iso || localExpiry(iso) !== expiry) {
        setError(t('apiKeys.invalidExpiry'))
        return
      }
      expiresAt = iso
    }
    setBusy(true)
    setError('')
    try {
      const key: GatewayApiKeyConfig = {
        id: draft.id,
        key: draft.key.trim(),
        enabled: draft.enabled !== false,
        ...(draft.name?.trim() ? { name: draft.name.trim() } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        ...(restricted ?
          {
            allowedModels: [
              ...new Set(
                models
                  .split('\n')
                  .map((model) => model.trim())
                  .filter(Boolean),
              ),
            ],
          }
        : {}),
        ...(period === 'none' ? {} : { quota: { period, amount } }),
      }
      setKeys(await window.electronAPI.saveManagedApiKey(key))
      setDraft(null)
      setUsage(await window.electronAPI.getApiKeyQuotaUsage().catch(() => null))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('apiKeys.saveError'))
      try {
        setKeys(await window.electronAPI.getManagedApiKeys())
      } catch {
        /* Preserve the editable draft. */
      }
    } finally {
      setBusy(false)
    }
  }
  const remove = async (key: GatewayApiKeyConfig) => {
    if (!window.confirm(t('apiKeys.removeConfirm'))) return
    setBusy(true)
    setError('')
    try {
      setKeys(await window.electronAPI.removeManagedApiKey(key.id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('apiKeys.saveError'))
    } finally {
      setBusy(false)
    }
  }
  const field =
    'block min-w-0 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15 disabled:opacity-50'
  const button =
    'inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border border-line bg-surface px-4 text-[13px] font-medium text-ink-soft transition hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40'
  const primaryButton = `inline-flex h-9 shrink-0 items-center justify-center px-4 ${primaryButtonClass}`
  return (
    <section
      className="w-full space-y-5 px-5 pb-5 pt-3 sm:px-6 sm:pb-6"
      aria-label={t('apiKeys.title')}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-ink">
            {t('apiKeys.title')}
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-faint">
            {t('apiKeys.immediate')}
          </p>
        </div>
        <button
          type="button"
          className={primaryButton}
          disabled={busy || draft !== null}
          onClick={() =>
            edit({
              id: 'key_' + crypto.randomUUID(),
              key: generateSecret(),
              enabled: true,
            })
          }
        >
          {t('apiKeys.add')}
        </button>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-600 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-400"
        >
          {error}
        </p>
      )}
      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4">
        <div>
          <div className="text-[13px] font-medium text-ink">
            {t('apiKeys.isolateUsage')}
          </div>
          <p className="mt-1 text-xs leading-5 text-ink-faint">
            {t('apiKeys.isolateUsageHint')}
          </p>
        </div>
        <div className="shrink-0">
          <input
            type="checkbox"
            role="switch"
            aria-label={t('apiKeys.isolateUsage')}
            checked={usageIsolation === true}
            disabled={busy || usageIsolation === null}
            onChange={(event) => void saveUsageIsolation(event.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className="relative block h-5 w-9 rounded-full bg-sunken ring-1 ring-inset ring-line transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-emerald-500 peer-checked:ring-emerald-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400 peer-disabled:opacity-40"
          />
        </div>
      </label>
      <div className="grid gap-4 lg:grid-cols-2">
        {keys.length === 0 && (
          <p className="rounded-xl border border-dashed border-line bg-surface px-6 py-12 text-center text-sm text-ink-faint lg:col-span-2">
            {t('apiKeys.empty')}
          </p>
        )}
        {keys.map((key) => {
          const current = usage?.find((item) => item.id === key.id)
          const expired =
            key.expiresAt !== undefined
            && Date.parse(key.expiresAt) <= Date.now()
          return (
            <div
              key={key.id}
              className="min-w-0 rounded-xl border border-line bg-surface p-4 text-[13px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-ink">
                  {key.name ?? t('apiKeys.unnamed')}
                </span>
                <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-soft">
                  {t(
                    key.enabled === false ? 'apiKeys.disabled'
                    : expired ? 'apiKeys.expired'
                    : 'apiKeys.enabled',
                  )}
                </span>
              </div>
              <div className="mt-2 font-mono text-xs text-ink-soft">
                {key.key.length > 8 ?
                  key.key.slice(0, 4) + '••••••••' + key.key.slice(-4)
                : '••••••••'}
              </div>
              <div className="mt-1 text-ink-faint">
                {t('apiKeys.usage')}:{' '}
                {current ? formatCostAmount('USD', current.usedAmount) : '—'} /{' '}
                {key.quota ?
                  formatCostAmount('USD', key.quota.amount)
                : t('apiKeys.unlimited')}
                {current?.remainingAmount !== null
                  && current?.remainingAmount !== undefined && (
                    <span>
                      {' '}
                      · {t('apiKeys.remaining')}:{' '}
                      {formatCostAmount('USD', current.remainingAmount)}
                    </span>
                  )}
              </div>
              {current?.resetsAt && (
                <div className="mt-1 text-ink-faint">
                  {t('apiKeys.resets')}:{' '}
                  {displayDateTime.format(current.resetsAt)}
                </div>
              )}
              {key.expiresAt && (
                <div className="mt-1 text-ink-faint">
                  {t('apiKeys.expires')}:{' '}
                  {displayDateTime.format(new Date(key.expiresAt))}
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={button}
                  disabled={busy || draft !== null}
                  onClick={() => edit(key)}
                >
                  {t('apiKeys.edit')}
                </button>
                <button
                  type="button"
                  className={button}
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(key.key)
                      .catch(() => setError(t('apiKeys.saveError')))
                  }
                >
                  {t('apiKeys.copy')}
                </button>
                <button
                  type="button"
                  className={`${button} hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 dark:hover:border-rose-500/25 dark:hover:bg-rose-500/10 dark:hover:text-rose-400`}
                  disabled={busy}
                  onClick={() => void remove(key)}
                >
                  {t('apiKeys.remove')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {usage === null && (
        <p className="mt-2 text-[12px] text-ink-faint">
          {t('apiKeys.unavailable')}
        </p>
      )}
      {draft && (
        <form
          className="grid gap-4 rounded-xl border border-line bg-surface p-5 sm:grid-cols-2"
          aria-label={t('apiKeys.edit')}
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="block text-xs text-ink-soft">
            {t('apiKeys.name')}
            <input
              aria-label={t('apiKeys.name')}
              className={`mt-1.5 ${field}`}
              value={draft.name ?? ''}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label className="block text-xs text-ink-soft">
            {t('apiKeys.secret')}
            <div className="mt-1.5 flex items-center gap-3">
              <input
                aria-label={t('apiKeys.secret')}
                type="password"
                autoComplete="off"
                className={field}
                value={draft.key}
                onChange={(event) =>
                  setDraft({ ...draft, key: event.target.value })
                }
              />
              <button
                type="button"
                className={button}
                onClick={() => setDraft({ ...draft, key: generateSecret() })}
              >
                {t('apiKeys.rotate')}
              </button>
            </div>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={draft.enabled !== false}
              onChange={(event) =>
                setDraft({ ...draft, enabled: event.target.checked })
              }
            />
            {t('apiKeys.enabled')}
          </label>
          <ApiKeyExpiryPicker
            locale={locale}
            value={expiry}
            onChange={setExpiry}
          />
          <label className="flex items-center gap-2 text-xs text-ink-soft sm:col-span-2">
            <input
              type="checkbox"
              checked={restricted}
              onChange={(event) => setRestricted(event.target.checked)}
            />
            {t('apiKeys.restrictModels')}
          </label>
          {restricted && (
            <label className="block text-xs text-ink-soft sm:col-span-2">
              {t('apiKeys.models')}
              <textarea
                aria-label={t('apiKeys.models')}
                rows={3}
                className={`mt-1.5 ${field}`}
                value={models}
                onChange={(event) => setModels(event.target.value)}
              />
              <span className="text-ink-faint">{t('apiKeys.modelsHint')}</span>
            </label>
          )}
          <label className="block text-xs text-ink-soft">
            {t('apiKeys.quota')}
            <select
              aria-label={t('apiKeys.quota')}
              className={`mt-1.5 ${field}`}
              value={period}
              onChange={(event) =>
                setPeriod(event.target.value as typeof period)
              }
            >
              {(['none', 'day', 'month', 'lifetime'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(
                    value === 'none' ? 'apiKeys.unlimited'
                    : value === 'day' ? 'apiKeys.day'
                    : value === 'month' ? 'apiKeys.month'
                    : 'apiKeys.lifetime',
                  )}
                </option>
              ))}
            </select>
          </label>
          {period !== 'none' && (
            <label className="block text-xs text-ink-soft">
              {t('apiKeys.limit')}
              <input
                aria-label={t('apiKeys.limit')}
                type="number"
                min="0"
                step="any"
                required
                className={`mt-1.5 ${field}`}
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </label>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <button type="submit" className={primaryButton} disabled={busy}>
              {t('apiKeys.save')}
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {t('apiKeys.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
