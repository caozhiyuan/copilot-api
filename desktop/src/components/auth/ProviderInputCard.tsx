import type {
  ModelsDevProviderOption,
  ProviderAuthTypeInput,
  ProviderType,
} from '../../types/ipc'

import {
  getQuickProviderLabel,
  PROVIDER_AUTH_TYPES,
  PROVIDER_COLORS,
  PROVIDER_TYPES,
  QUICK_PROVIDER_DEFAULTS,
  type AuthTranslateFn,
  type ProviderChoice,
} from './auth-constants'

interface ManualTokenCardProps {
  loading: boolean
  onBack: () => void
  onSave: () => void
  onTokenInputChange: (value: string) => void
  t: AuthTranslateFn
  tokenInput: string
}

export function ManualTokenCard({
  loading,
  onBack,
  onSave,
  onTokenInputChange,
  t,
  tokenInput,
}: ManualTokenCardProps) {
  return (
    <div className="w-full max-w-[320px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
      <textarea
        value={tokenInput}
        onChange={(e) => onTokenInputChange(e.target.value)}
        placeholder="gho_xxxxxxxxxxxxxxxx"
        rows={3}
        className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-accent/40 font-mono bg-surface text-ink placeholder-ink-faint"
      />
      <button
        onClick={onSave}
        disabled={loading || !tokenInput.trim()}
        className="w-full py-2.5 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 disabled:opacity-50 transition-colors"
      >
        {loading ? t('auth.verifying') : t('auth.confirmAdd')}
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

interface ProviderInputCardProps {
  loading: boolean
  modelsDevError: boolean
  modelsDevLoading: boolean
  modelsDevProviders: Array<ModelsDevProviderOption>
  onBack: () => void
  onModelsDevProviderSelect: (providerId: string) => void
  onProviderApiKeyChange: (value: string) => void
  onProviderAuthTypeChange: (value: ProviderAuthTypeInput) => void
  onProviderBaseUrlChange: (value: string) => void
  onProviderNameChange: (value: string) => void
  onProviderTypeChange: (value: ProviderType) => void
  onSave: () => void
  providerApiKey: string
  providerAuthType: ProviderAuthTypeInput
  providerBaseUrl: string
  providerChoice: ProviderChoice
  providerName: string
  providerType: ProviderType
  selectedModelsDevProviderId: string
  t: AuthTranslateFn
}

export function ProviderInputCard({
  loading,
  modelsDevError,
  modelsDevLoading,
  modelsDevProviders,
  onBack,
  onModelsDevProviderSelect,
  onProviderApiKeyChange,
  onProviderAuthTypeChange,
  onProviderBaseUrlChange,
  onProviderNameChange,
  onProviderTypeChange,
  onSave,
  providerApiKey,
  providerAuthType,
  providerBaseUrl,
  providerChoice,
  providerName,
  providerType,
  selectedModelsDevProviderId,
  t,
}: ProviderInputCardProps) {
  const isCustomProvider = providerChoice === 'custom'
  const selectedQuickProvider =
    isCustomProvider ? null : QUICK_PROVIDER_DEFAULTS[providerChoice]
  const selectedProviderLabel =
    isCustomProvider ?
      t('auth.customProvider')
    : getQuickProviderLabel(t, providerChoice)
  const canEditProviderType =
    isCustomProvider || selectedQuickProvider?.editableType

  return (
    <div
      className={`w-full ${isCustomProvider ? 'max-w-[560px]' : 'max-w-[360px]'} flex flex-col gap-2.5 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]`}
    >
      <div className="flex items-center justify-center gap-1.5 text-[13px] font-semibold text-ink">
        {!isCustomProvider && selectedQuickProvider && (
          <span
            className={`w-1.5 h-1.5 rounded-full ${PROVIDER_COLORS[providerChoice]}`}
          />
        )}
        {selectedProviderLabel}
      </div>

      <div
        className={
          isCustomProvider ?
            'grid gap-2.5 sm:grid-cols-2'
          : 'flex flex-col gap-3'
        }
      >
        {isCustomProvider && (
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-[13px] text-ink-faint">
              {t('auth.modelsDevProvider')}
            </span>
            <select
              value={selectedModelsDevProviderId}
              onChange={(e) => onModelsDevProviderSelect(e.target.value)}
              disabled={modelsDevLoading}
              className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
            >
              <option value="">
                {modelsDevLoading ?
                  t('auth.modelsDevLoading')
                : t('auth.modelsDevManual')}
              </option>
              {modelsDevProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ({provider.id}) · {provider.type}
                </option>
              ))}
            </select>
            {modelsDevError && (
              <span className="text-[12px] text-amber-600 dark:text-amber-400">
                {t('auth.modelsDevUnavailable')}
              </span>
            )}
          </label>
        )}

        {isCustomProvider && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-ink-faint">
              {t('auth.providerName')}
            </span>
            <input
              value={providerName}
              onChange={(e) => onProviderNameChange(e.target.value)}
              placeholder="dashscope"
              className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] bg-surface text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </label>
        )}

        {canEditProviderType && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-ink-faint">
              {t('auth.providerType')}
            </span>
            <select
              value={providerType}
              onChange={(e) =>
                onProviderTypeChange(e.target.value as ProviderType)
              }
              className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              {PROVIDER_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
        )}

        <label
          className={`flex flex-col gap-1.5 ${isCustomProvider ? 'sm:col-span-2' : ''}`}
        >
          <span className="text-[13px] text-ink-faint">
            {t('auth.providerBaseUrl')}
          </span>
          <input
            value={providerBaseUrl}
            onChange={(e) => onProviderBaseUrlChange(e.target.value)}
            placeholder="https://api.example.com"
            className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] bg-surface text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>

        <label
          className={`flex flex-col gap-1.5 ${isCustomProvider ? 'sm:col-span-2' : ''}`}
        >
          <span className="text-[13px] text-ink-faint">
            {t('auth.providerApiKey')}
          </span>
          <textarea
            value={providerApiKey}
            onChange={(e) => onProviderApiKeyChange(e.target.value)}
            placeholder="sk-..."
            rows={isCustomProvider ? 2 : 3}
            className="w-full px-3 py-2.5 border border-line rounded-lg text-[13px] resize-none focus:outline-none focus:ring-2 focus:ring-accent/40 font-mono bg-surface text-ink placeholder-ink-faint"
          />
        </label>

        {isCustomProvider && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] text-ink-faint">
              {t('auth.providerAuthType')}
            </span>
            <select
              value={providerAuthType}
              onChange={(e) =>
                onProviderAuthTypeChange(
                  e.target.value as ProviderAuthTypeInput,
                )
              }
              className="w-full px-3 py-2.5 border border-line rounded-lg bg-surface text-ink text-[13px] focus:outline-none focus:ring-2 focus:ring-accent/40"
            >
              {PROVIDER_AUTH_TYPES.map((authType) => (
                <option key={authType} value={authType}>
                  {authType === '__default__' ?
                    t('auth.providerAuthTypeDefault')
                  : authType}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <button
        onClick={onSave}
        disabled={loading || !providerApiKey.trim()}
        className="w-full py-2.5 bg-accent-strong text-white text-[13px] font-semibold rounded-lg hover:bg-accent-strong/90 disabled:opacity-50 transition-colors"
      >
        {loading ? t('auth.verifying') : t('auth.confirmAdd')}
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
