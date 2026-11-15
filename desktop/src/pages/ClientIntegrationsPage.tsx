import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { primaryButtonClass } from '../lib/button-styles'
import type { LocaleKey } from '../locales'
import type { ClientIntegrationReply } from '../types/ipc'
import {
  CLIENT_ERROR_CODES,
  type ClientId,
  type ClientIntegrationStatus,
  type ClientIntegrationsState,
  type ClientModelOption,
  type ClientPlugin,
} from '../../shared/client-integrations'

const fieldClass =
  'mt-1.5 block w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15 disabled:opacity-50'
const buttonClass =
  'rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft transition hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40'
const primaryClass = `px-3 py-2 ${primaryButtonClass}`
const clientColumns: ClientId[][] = [['codex', 'claude'], ['opencode']]
const clientOrder: Record<ClientId, string> = {
  codex: 'order-1',
  opencode: 'order-2',
  claude: 'order-3',
}
const initialClientStatuses: ClientIntegrationStatus[] = clientColumns
  .flat()
  .map((client) => ({
    client,
    configPath: '',
    revision: '',
    state: 'unconfigured',
    canRestore: false,
    model: '',
    smallModel: '',
    nativeToolSearch: false,
    agentContext: false,
    plugins: [],
  }))
type ClientCheckState = 'checking' | 'error' | undefined
type Translate = ReturnType<typeof useLanguage>['t']

function errorText(t: Translate, code: string) {
  const known =
    CLIENT_ERROR_CODES.find((value) => value === code) ?? 'operationFailed'
  return t(`clients.errors.${known}`)
}
function unwrap<T>(reply: ClientIntegrationReply<T>): T {
  if ('error' in reply) throw new Error(reply.error)
  return reply.data
}

export default function ClientIntegrationsPage({
  serverRunning,
  initialBaseUrl = '',
}: {
  serverRunning: boolean
  initialBaseUrl?: string
}) {
  const { t } = useLanguage()
  const [state, setState] = useState<ClientIntegrationsState>()
  const [apiKey, setApiKey] = useState('dummy')
  const [models, setModels] = useState<
    Partial<Record<ClientId, ClientModelOption[]>>
  >({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const displayState = state ?? {
    baseUrl: initialBaseUrl,
    apiKeys: [],
    clients: initialClientStatuses,
    harnessProfiles: [],
  }
  const checkState: ClientCheckState =
    loading ? 'checking'
    : state ? undefined
    : 'error'

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    setModelError(false)
    setModels({})
    void window.electronAPI
      .getClientIntegrations()
      .then((reply) => {
        const value = unwrap(reply)
        if (!active) return
        setState(value)
        setApiKey((key) =>
          value.apiKeys.includes(key) ? key : (value.apiKeys[0] ?? 'dummy'),
        )
      })
      .catch((error: unknown) => {
        if (active)
          setError(error instanceof Error ? error.message : 'operationFailed')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    if (serverRunning) {
      for (const client of ['claude', 'codex'] as const) {
        void window.electronAPI
          .getClientModels(client)
          .then((reply) => {
            const value = unwrap(reply)
            if (active)
              setModels((current) => ({ ...current, [client]: value }))
          })
          .catch(() => {
            if (active) setModelError(true)
          })
      }
    }
    return () => {
      active = false
    }
  }, [serverRunning, refresh])

  const updateStatus = (status: ClientIntegrationStatus) =>
    setState(
      (current) =>
        current && {
          ...current,
          clients: current.clients.map((item) =>
            item.client === status.client ? status : item,
          ),
        },
    )

  return (
    <div className="w-full space-y-5 px-5 pb-5 pt-3 sm:px-6 sm:pb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {t('clients.title')}
          </h2>
          <p className="mt-1 text-[13px] leading-6 text-ink-faint">
            {t('clients.description')}
          </p>
        </div>
        <button
          className={buttonClass}
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {t(loading ? 'clients.loading' : 'clients.refresh')}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {errorText(t, error)}
        </p>
      )}
      <>
        <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-ink-faint">{t('clients.gateway')}</p>
            <p className="mt-2 break-all font-mono text-sm text-ink">
              {displayState.baseUrl || '—'}
            </p>
          </div>
          <label className="text-xs text-ink-soft">
            {t('clients.apiKey')}
            <select
              className={fieldClass}
              value={apiKey}
              disabled={!!checkState}
              onChange={(event) => setApiKey(event.target.value)}
            >
              {!state ?
                <option value={apiKey}>
                  {t(
                    checkState === 'error' ? 'clients.error' : (
                      'clients.loading'
                    ),
                  )}
                </option>
              : displayState.apiKeys.length ?
                displayState.apiKeys.map((key, index) => (
                  <option key={key} value={key}>
                    {t('clients.keyNumber', { n: index + 1 })}
                  </option>
                ))
              : <option value="dummy">{t('clients.noAuth')}</option>}
            </select>
          </label>
        </div>
        {!serverRunning && (
          <p className="text-xs leading-5 text-ink-faint">
            {t('clients.stopped')}
          </p>
        )}
        {modelError && (
          <p
            role="alert"
            className="text-xs text-amber-600 dark:text-amber-400"
          >
            {t('clients.errors.modelsFailed')}
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          {clientColumns.map((clients, index) => (
            <div key={index} className="contents lg:flex lg:flex-col lg:gap-4">
              {clients
                .flatMap((client) =>
                  displayState.clients.filter(
                    (status) => status.client === client,
                  ),
                )
                .map((status) => (
                  <ClientCard
                    key={status.client}
                    status={status}
                    checkState={checkState}
                    apiKey={apiKey}
                    models={models[status.client] ?? []}
                    onUpdate={updateStatus}
                    t={t}
                  />
                ))}
              {index === 1 && (
                <HarnessCard
                  profiles={displayState.harnessProfiles}
                  checking={!!checkState}
                  t={t}
                />
              )}
            </div>
          ))}
        </div>
      </>
    </div>
  )
}

function ClientCard({
  status,
  checkState,
  apiKey,
  models,
  onUpdate,
  t,
}: {
  status: ClientIntegrationStatus
  checkState: ClientCheckState
  apiKey: string
  models: ClientModelOption[]
  onUpdate: (status: ClientIntegrationStatus) => void
  t: Translate
}) {
  const [model, setModel] = useState(status.model)
  const [smallModel, setSmallModel] = useState(
    status.smallModel === status.model ? '' : status.smallModel,
  )
  const [nativeToolSearch, setNativeToolSearch] = useState(
    status.nativeToolSearch,
  )
  const [agentContext, setAgentContext] = useState(status.agentContext)
  const [plugins, setPlugins] = useState(status.plugins)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pluginError, setPluginError] = useState('')
  useEffect(() => {
    setModel(status.model)
    setSmallModel(status.smallModel === status.model ? '' : status.smallModel)
    setNativeToolSearch(status.nativeToolSearch)
    setAgentContext(status.agentContext)
    setPlugins(status.plugins)
  }, [status])
  const names = {
    claude: 'Claude Code',
    opencode: 'OpenCode v2',
    codex: 'Codex',
  }
  const descriptions = {
    claude: 'clients.claudeDescription',
    opencode: 'clients.opencodeDescription',
    codex: 'clients.codexDescription',
  } satisfies Record<ClientId, LocaleKey>
  const action = async (operation: 'setup' | 'restore' | 'open') => {
    setBusy(true)
    setError('')
    setNotice('')
    setPluginError('')
    try {
      if (operation === 'open')
        unwrap(await window.electronAPI.openClientConfig(status.client))
      else if (operation === 'restore') {
        onUpdate(
          unwrap(
            await window.electronAPI.restoreClient(
              status.client,
              status.revision,
            ),
          ),
        )
        setNotice('restored')
      } else {
        const result = unwrap(
          await window.electronAPI.setupClient({
            client: status.client,
            revision: status.revision,
            apiKey,
            model,
            smallModel,
            nativeToolSearch,
            agentContext,
            plugins,
          }),
        )
        onUpdate(result.status)
        setNotice('saved')
        setPluginError(result.pluginError ?? '')
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'operationFailed')
    } finally {
      setBusy(false)
    }
  }
  const togglePlugin = (plugin: ClientPlugin, checked: boolean) => {
    setPlugins((current) =>
      checked ?
        [...current, plugin]
      : current.filter((item) => item !== plugin),
    )
    if (checked && plugin === 'tool-search') setNativeToolSearch(false)
  }
  const chooseModel = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    small = false,
  ) => {
    const available = [...models]
    if (value && !available.some((item) => item.id === value))
      available.unshift({ id: value, name: value })
    return (
      <label className="block text-xs text-ink-soft">
        {label}
        <select
          aria-label={`${names[status.client]}: ${label}`}
          className={fieldClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={busy}
        >
          <option value="">
            {t(small ? 'clients.sameModel' : 'clients.chooseModel')}
          </option>
          {available.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name === item.id ? item.id : `${item.name} · ${item.id}`}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <section
      data-client={status.client}
      className={`${clientOrder[status.client]} flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink">
          {names[status.client]}
        </h3>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] ${!checkState && status.state === 'configured' ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-sunken text-ink-faint'}`}
        >
          {t(
            checkState === 'checking' ? 'clients.loading' : (
              `clients.${checkState ?? status.state}`
            ),
          )}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-ink-faint">
        {t(descriptions[status.client])}
      </p>
      <fieldset disabled={busy || !!checkState} className="mt-5 space-y-4">
        {status.client !== 'opencode' && (
          <>
            {chooseModel(t('clients.model'), model, setModel)}
            {status.client === 'claude'
              && chooseModel(
                t('clients.smallModel'),
                smallModel,
                setSmallModel,
                true,
              )}
            <p className="text-[11px] leading-5 text-ink-faint">
              {t('clients.modelHint')}
            </p>
          </>
        )}
        {status.client === 'claude' && (
          <>
            <label className="flex items-center gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={nativeToolSearch}
                onChange={(event) => {
                  setNativeToolSearch(event.target.checked)
                  if (event.target.checked)
                    setPlugins((current) =>
                      current.filter((plugin) => plugin !== 'tool-search'),
                    )
                }}
              />
              {t('clients.nativeToolSearch')}
            </label>
            <details className="rounded-lg border border-line-soft p-3">
              <summary className="cursor-pointer text-xs text-ink-soft">
                {t('clients.optionalPlugins')}
              </summary>
              <div className="mt-3 space-y-3">
                <label className="flex items-center gap-2 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    checked={plugins.includes('agent-inject')}
                    onChange={(event) =>
                      togglePlugin('agent-inject', event.target.checked)
                    }
                  />
                  {t('clients.agentInject')}
                </label>
                <label className="flex items-center gap-2 text-xs text-ink-soft">
                  <input
                    type="checkbox"
                    checked={plugins.includes('tool-search')}
                    onChange={(event) =>
                      togglePlugin('tool-search', event.target.checked)
                    }
                  />
                  {t('clients.toolSearchBridge')}
                </label>
              </div>
            </details>
          </>
        )}
        {status.client === 'opencode' && (
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={agentContext}
              onChange={(event) => setAgentContext(event.target.checked)}
            />
            {t('clients.agentContext')}
          </label>
        )}
      </fieldset>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          className={primaryClass}
          disabled={
            busy
            || !!checkState
            || (status.client !== 'opencode' && !model)
            || status.state === 'error'
          }
          onClick={() => void action('setup')}
        >
          {t(
            busy ? 'clients.working'
            : status.state === 'configured' ? 'clients.update'
            : 'clients.configure',
          )}
        </button>
        <button
          className={buttonClass}
          disabled={busy || !!checkState || status.state === 'unconfigured'}
          onClick={() => void action('open')}
        >
          {t('clients.open')}
        </button>
        {status.canRestore && (
          <button
            className={buttonClass}
            disabled={busy || !!checkState}
            onClick={() => void action('restore')}
          >
            {t('clients.restore')}
          </button>
        )}
      </div>
      {notice && (
        <p
          role="status"
          className="mt-3 text-xs leading-5 text-green-600 dark:text-green-400"
        >
          {t(notice === 'saved' ? 'clients.saved' : 'clients.restored')}
        </p>
      )}
      {notice === 'saved' && status.client === 'codex' && (
        <p className="mt-2 text-xs leading-5 text-ink-faint">
          {t('clients.codexRestart')}
        </p>
      )}
      {(error || status.error) && (
        <p role="alert" className="mt-3 text-xs leading-5 text-red-500">
          {errorText(t, error || status.error!)}
        </p>
      )}
      {pluginError && (
        <p
          role="alert"
          className="mt-3 text-xs leading-5 text-amber-600 dark:text-amber-400"
        >
          {t('clients.pluginFailed')} {errorText(t, pluginError)}
        </p>
      )}
    </section>
  )
}

function HarnessCard({
  profiles,
  checking,
  t,
}: {
  profiles: string[]
  checking: boolean
  t: Translate
}) {
  const [profile, setProfile] = useState(
    profiles.includes('web') ? 'web' : (profiles[0] ?? 'web'),
  )
  const [busy, setBusy] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [error, setError] = useState('')
  const profileInitialized = useRef(false)
  useEffect(() => {
    if (checking || profileInitialized.current) return
    profileInitialized.current = true
    setProfile(profiles.includes('web') ? 'web' : (profiles[0] ?? 'web'))
  }, [profiles, checking])
  const install = async () => {
    setBusy(true)
    setError('')
    setInstalled(false)
    try {
      unwrap(await window.electronAPI.installHarnessPlugin(profile))
      setInstalled(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'operationFailed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      data-client="harness"
      className="order-4 flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5"
    >
      <h3 className="text-base font-semibold text-ink">DeepSeek Harness</h3>
      <p className="mt-2 text-xs leading-5 text-ink-faint">
        {t('clients.harnessDescription')}
      </p>
      <label className="mt-5 block text-xs text-ink-soft">
        {t('clients.profile')}
        <input
          className={fieldClass}
          list="harness-profiles"
          value={profile}
          onChange={(event) => {
            setProfile(event.target.value)
            setInstalled(false)
          }}
          disabled={busy || checking}
        />
        <datalist id="harness-profiles">
          {profiles.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>
      <p className="mt-3 text-[11px] leading-5 text-ink-faint">
        {t('clients.harnessHint')}
      </p>
      <div className="mt-5 flex flex-col items-start">
        <button
          className={primaryClass}
          disabled={busy || checking || !/^[\w-]{1,80}$/.test(profile)}
          onClick={() => void install()}
        >
          {t(busy ? 'clients.working' : 'clients.installPlugin')}
        </button>
        {installed && (
          <p
            role="status"
            className="mt-3 text-xs leading-5 text-green-600 dark:text-green-400"
          >
            {t('clients.pluginInstalled')}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs leading-5 text-red-500">
            {errorText(t, error)}
          </p>
        )}
      </div>
    </section>
  )
}
