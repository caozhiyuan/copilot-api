import { useEffect, useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import type {
  ProviderManagementConfig,
  ProviderModelOptions,
} from '../types/ipc'
import {
  buildProviderManagementUpdate,
  createProviderDrafts,
  type ModelSelectionMode,
  type ProviderDraft,
} from '../lib/provider-management-editor'
import {
  mergeProviderModelOptions,
  parseModelSelection,
} from '../lib/provider-model-options'
import ProviderModelPicker from './ProviderModelPicker'

interface Props {
  serverRunning?: boolean
  onSavingChange?: (saving: boolean) => void
}

const protocolLabels: Record<string, string> = {
  anthropic: 'Anthropic',
  'github-copilot': 'GitHub Copilot',
  'openai-compatible': 'Chat Completions',
  'openai-responses': 'Responses API',
  google: 'Google Gemini API',
}

export default function ProviderManagementPanel({
  serverRunning,
  onSavingChange,
}: Props) {
  const { t } = useLanguage()
  const [config, setConfig] = useState<ProviderManagementConfig | null>(null)
  const [drafts, setDrafts] = useState<ProviderDraft[]>([])
  const [activeName, setActiveName] = useState('')
  const [modelOptions, setModelOptions] = useState<ProviderModelOptions>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let active = true
    window.electronAPI
      .getProviderManagementConfig()
      .then((result) => {
        if (!active) return
        setConfig(result)
        setDrafts(createProviderDrafts(result))
        setActiveName(result.providers[0]?.name ?? '')
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason))
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!config) return
    let active = true
    setModelsLoading(true)
    setModelsError(false)
    const loadModels = async () => {
      const [local, discovered] = await Promise.allSettled([
        window.electronAPI.getProviderModelOptions(),
        serverRunning ?
          window.electronAPI.fetchModels()
        : Promise.resolve(null),
      ])
      if (!active) return
      const options = Object.fromEntries(
        config.providers.map((provider) => [
          provider.name,
          local.status === 'fulfilled' ?
            (local.value[provider.name] ?? [])
          : [],
        ]),
      )
      setModelOptions(
        mergeProviderModelOptions(
          options,
          discovered.status === 'fulfilled' ? discovered.value : null,
        ),
      )
      setModelsError(local.status === 'rejected')
      setModelsLoading(false)
    }
    void loadModels()
    return () => {
      active = false
    }
  }, [config, serverRunning])

  const editProvider = (name: string, update: Partial<ProviderDraft>) => {
    setDrafts((previous) =>
      previous.map((draft) =>
        draft.name === name ? { ...draft, ...update } : draft,
      ),
    )
    setSaved(false)
    setDirty(true)
  }

  const save = async () => {
    if (!config) return
    setSaving(true)
    onSavingChange?.(true)
    setError('')
    setSaved(false)
    try {
      const result = await window.electronAPI.saveProviderManagementConfig(
        buildProviderManagementUpdate(drafts, config),
      )
      setConfig(result)
      setDrafts(createProviderDrafts(result))
      setActiveName((name) =>
        result.providers.some((provider) => provider.name === name) ?
          name
        : (result.providers[0]?.name ?? ''),
      )
      setDirty(false)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
      onSavingChange?.(false)
    }
  }

  const current = drafts.find((draft) => draft.name === activeName)
  const modeDescriptions: Record<ModelSelectionMode, string> = {
    auto: t('providers.autoDescription'),
    selected: t('providers.selectedDescription'),
    none: t('providers.noneDescription'),
  }
  const modeLabel = (mode: ModelSelectionMode) =>
    t(
      mode === 'auto' ? 'providers.auto'
      : mode === 'selected' ? 'providers.selected'
      : 'providers.none',
    )

  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden px-5 pb-5 pt-3 sm:px-6 sm:pb-6">
      <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-ink">
            {t('providers.title')}
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-faint">
            {t('providers.description')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-1">
          {dirty && (
            <span className="hidden text-xs text-ink-faint sm:inline">
              {t('providers.unsaved')}
            </span>
          )}
          <button
            type="button"
            disabled={saving || !config}
            onClick={() => {
              void save()
            }}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent-strong px-4 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="m5 12 4 4L19 6" />
            </svg>
            {t(saving ? 'providers.saving' : 'providers.save')}
          </button>
        </div>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-600 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-400"
        >
          {error}
        </p>
      )}
      {saved && (
        <p
          role="status"
          className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-[13px] text-green-700 dark:border-green-500/25 dark:bg-green-500/10 dark:text-green-400"
        >
          {t(serverRunning ? 'providers.savedRefreshed' : 'providers.saved')}
        </p>
      )}
      {!config && !error && (
        <p className="py-12 text-center text-sm text-ink-faint">
          {t('providers.loading')}
        </p>
      )}
      {config && drafts.length === 0 && (
        <div className="rounded-2xl border border-dashed border-line bg-surface px-6 py-16 text-center text-sm text-ink-faint">
          {t('providers.empty')}
        </div>
      )}
      {current && (
        <fieldset
          disabled={saving}
          className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-5 md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
        >
          <nav
            aria-label={t('providers.title')}
            className="max-h-32 min-h-0 space-y-1 self-start overflow-y-auto rounded-xl border border-line-soft bg-surface p-2 md:max-h-full"
          >
            <p className="px-3 pb-2 pt-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
              {t('providers.configured')}
            </p>
            {drafts.map((draft) => (
              <button
                key={draft.name}
                type="button"
                aria-label={draft.name}
                aria-pressed={draft.name === activeName}
                onClick={() => setActiveName(draft.name)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors ${draft.name === activeName ? 'bg-sunken text-ink' : 'text-ink-soft hover:bg-sunken/60'}`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold ${draft.name === activeName ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-400' : 'border-line bg-canvas text-ink-faint'}`}
                >
                  {draft.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold">
                    {draft.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-ink-faint">
                    {draft.mode === 'selected' ?
                      t('providers.selectedCount').replace(
                        '{count}',
                        String(parseModelSelection(draft.models).length),
                      )
                    : modeLabel(draft.mode)}
                  </span>
                </span>
                <span
                  aria-label={t(
                    draft.enabled ? 'providers.enabled' : 'providers.disabled',
                  )}
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${draft.enabled ? 'bg-emerald-500' : 'bg-ink-faint/40'}`}
                />
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-line-soft bg-surface shadow-sm">
            <div className="flex shrink-0 items-center justify-between gap-4 border-b border-line-soft px-5 py-3">
              <div className="min-w-0">
                <h3 className="truncate text-lg font-semibold text-ink">
                  {current.name}
                </h3>
                <span className="mt-1 inline-block rounded-md bg-sunken px-2 py-0.5 text-[11px] text-ink-soft">
                  {protocolLabels[current.type] ?? current.type}
                </span>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2.5 text-[12px] font-medium text-ink-soft">
                {t(
                  current.enabled ? 'providers.enabled' : 'providers.disabled',
                )}
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={`${current.name}: ${t('providers.enabled')}`}
                  checked={current.enabled}
                  onChange={(event) =>
                    editProvider(current.name, {
                      enabled: event.target.checked,
                    })
                  }
                  className="peer sr-only"
                />
                <span className="relative h-5 w-9 rounded-full bg-sunken ring-1 ring-inset ring-line transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:bg-emerald-500 peer-checked:ring-emerald-500 peer-checked:after:translate-x-4 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-400" />
              </label>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
              <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
                <h4 className="text-[13px] font-semibold text-ink">
                  {t('providers.selection')}
                </h4>
              </div>
              <div
                role="radiogroup"
                aria-label={t('providers.selection')}
                className="grid shrink-0 grid-cols-3 gap-2"
              >
                {(['auto', 'selected', 'none'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={current.mode === mode}
                    onClick={() => editProvider(current.name, { mode })}
                    className={`rounded-xl border px-3 py-3 text-left transition-colors ${current.mode === mode ? 'border-blue-300 bg-blue-50/70 ring-1 ring-blue-300/30 dark:border-blue-500/50 dark:bg-blue-500/10' : 'border-line bg-canvas hover:border-line-soft hover:bg-sunken'}`}
                  >
                    <span
                      className={`block text-[12px] font-semibold ${current.mode === mode ? 'text-blue-700 dark:text-blue-300' : 'text-ink'}`}
                    >
                      {modeLabel(mode)}
                    </span>
                    <span className="mt-1 block text-[11px] leading-4 text-ink-faint">
                      {modeDescriptions[mode]}
                    </span>
                  </button>
                ))}
              </div>
              {current.mode !== 'none' ?
                <ProviderModelPicker
                  key={current.name}
                  provider={current.name}
                  options={modelOptions[current.name] ?? []}
                  value={current.models}
                  readOnly={current.mode === 'auto'}
                  loading={modelsLoading}
                  onChange={(models) => editProvider(current.name, { models })}
                />
              : <div className="mt-5 rounded-xl border border-dashed border-line bg-canvas px-4 py-12 text-center">
                  <p className="text-[13px] font-medium text-ink-soft">
                    {t('providers.hiddenTitle')}
                  </p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {t('providers.hiddenDescription')}
                  </p>
                </div>
              }
            </div>
            <div className="shrink-0 border-t border-line-soft bg-canvas/60 px-5 py-3">
              <p className="text-[11px] leading-5 text-ink-faint">
                {t(
                  modelsError ?
                    'providers.modelsError'
                  : 'providers.modelSourceHint',
                )}
              </p>
            </div>
          </div>
        </fieldset>
      )}
    </section>
  )
}
