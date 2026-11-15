import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { primaryButtonClass } from '../lib/button-styles'
import type { LocaleKey } from '../locales'
import type { ClientIntegrationReply } from '../types/ipc'
import {
  CLIENT_ERROR_CODES,
  type ClientAgent,
  type ClientCommandFailure,
  type ClientId,
  type ClientIntegrationStatus,
  type ClientIntegrationsState,
  type ClientModelOption,
  type ClientPlugin,
} from '../../shared/client-integrations'

const fieldClass =
  'mt-1.5 block w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13px] text-ink outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/15 disabled:opacity-50'
const gatewayClass =
  'mt-1.5 flex min-w-0 w-full items-center break-all border-y border-transparent py-2 font-mono text-[13px] text-ink'
const buttonClass =
  'rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft transition hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40'
const primaryClass = `px-3 py-2 ${primaryButtonClass}`
const agents: ClientAgent[] = ['codex', 'opencode', 'claude', 'harness']
const agentNames: Record<ClientAgent, string> = {
  codex: 'Codex',
  opencode: 'OpenCode v2',
  claude: 'Claude Code',
  harness: 'DeepSeek Harness',
}
const agentPreferenceKey = 'copilot-api-client-agent'
const initialClientStatuses: ClientIntegrationStatus[] = (
  ['codex', 'opencode', 'claude', 'harness'] as const
).map((client) => ({
  client,
  configPath: '',
  revision: '',
  state: 'unconfigured',
  canRestore: false,
  model: '',
  fableModel: '',
  opusModel: '',
  sonnetModel: '',
  smallModel: '',
  reviewModel: '',
  nativeToolSearch: false,
  agentContext: true,
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
  const [agent, setAgent] = useState<ClientAgent>(
    () =>
      agents.find(
        (value) => value === window.localStorage.getItem(agentPreferenceKey),
      ) ?? 'codex',
  )
  const [state, setState] = useState<ClientIntegrationsState>()
  const [apiKey, setApiKey] = useState('dummy')
  const [models, setModels] = useState<ClientModelOption[]>([])
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
    setModels([])
    void window.electronAPI
      .getClientIntegrations(agent)
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
    if (serverRunning && (agent === 'claude' || agent === 'codex')) {
      void window.electronAPI
        .getClientModels(agent)
        .then((reply) => {
          const value = unwrap(reply)
          if (active) setModels(value)
        })
        .catch(() => {
          if (active) setModelError(true)
        })
    }
    return () => {
      active = false
    }
  }, [agent, serverRunning, refresh])

  const selectAgent = (next: ClientAgent) => {
    if (next === agent) return
    setAgent(next)
    window.localStorage.setItem(agentPreferenceKey, next)
    setState(undefined)
    setModels([])
    setError('')
    setModelError(false)
    setLoading(true)
  }
  const selectedStatus = displayState.clients.find(
    (item) => item.client === agent,
  )

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
        <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:grid-cols-3">
          <label className="text-xs text-ink-soft">
            {t('clients.agent')}
            <select
              aria-label={t('clients.agent')}
              className={fieldClass}
              value={agent}
              onChange={(event) =>
                selectAgent(event.target.value as ClientAgent)
              }
            >
              {agents.map((value) => (
                <option key={value} value={value}>
                  {agentNames[value]}
                </option>
              ))}
            </select>
          </label>
          <div className="min-w-0 text-xs text-ink-soft">
            <p>{t('clients.gateway')}</p>
            <p className={gatewayClass}>{displayState.baseUrl || '—'}</p>
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
        {!serverRunning && (agent === 'claude' || agent === 'codex') && (
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
        {selectedStatus && (
          <ClientCard
            key={agent}
            status={selectedStatus}
            checkState={checkState}
            apiKey={apiKey}
            models={models}
            profiles={displayState.harnessProfiles}
            onUpdate={updateStatus}
            t={t}
          />
        )}
      </>
    </div>
  )
}

function ClientCard({
  status,
  checkState,
  apiKey,
  models,
  profiles,
  onUpdate,
  t,
}: {
  status: ClientIntegrationStatus
  checkState: ClientCheckState
  apiKey: string
  models: ClientModelOption[]
  profiles: string[]
  onUpdate: (status: ClientIntegrationStatus) => void
  t: Translate
}) {
  const [model, setModel] = useState(status.model)
  const [fableModel, setFableModel] = useState(status.fableModel)
  const [opusModel, setOpusModel] = useState(status.opusModel)
  const [sonnetModel, setSonnetModel] = useState(status.sonnetModel)
  const [smallModel, setSmallModel] = useState(status.smallModel)
  const [reviewModel, setReviewModel] = useState(status.reviewModel)
  const [nativeToolSearch, setNativeToolSearch] = useState(
    status.nativeToolSearch,
  )
  const [agentContext, setAgentContext] = useState(
    status.state === 'unconfigured' || status.agentContext,
  )
  const [plugins, setPlugins] = useState(status.plugins)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pluginError, setPluginError] = useState('')
  const [pluginFailure, setPluginFailure] = useState<ClientCommandFailure>()
  const [profile, setProfile] = useState(
    profiles.includes('web') ? 'web' : (profiles[0] ?? 'web'),
  )
  const profileInitialized = useRef(false)
  useEffect(() => {
    if (status.client !== 'harness' || checkState || profileInitialized.current)
      return
    profileInitialized.current = true
    setProfile(profiles.includes('web') ? 'web' : (profiles[0] ?? 'web'))
  }, [status.client, profiles, checkState])
  useEffect(() => {
    setModel(status.model)
    setFableModel(status.fableModel)
    setOpusModel(status.opusModel)
    setSonnetModel(status.sonnetModel)
    setSmallModel(status.smallModel)
    setReviewModel(status.reviewModel)
    setNativeToolSearch(status.nativeToolSearch)
    setAgentContext(status.state === 'unconfigured' || status.agentContext)
    setPlugins(status.plugins)
  }, [status])
  const descriptions = {
    claude: 'clients.claudeDescription',
    opencode: 'clients.opencodeDescription',
    codex: 'clients.codexDescription',
    harness: 'clients.harnessDescription',
  } satisfies Record<ClientId, LocaleKey>
  const action = async (operation: 'setup' | 'restore' | 'open') => {
    setBusy(true)
    setError('')
    setNotice('')
    setPluginError('')
    setPluginFailure(undefined)
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
            profile: status.client === 'harness' ? profile : undefined,
            model,
            fableModel,
            opusModel,
            sonnetModel,
            smallModel,
            reviewModel,
            nativeToolSearch,
            agentContext,
            plugins,
          }),
        )
        onUpdate(result.status)
        setNotice('saved')
        setPluginError(result.pluginError ?? '')
        setPluginFailure(result.pluginFailure)
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
  }
  const chooseModel = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder = t('clients.chooseModel'),
    choices = models,
  ) => {
    const available = [...choices]
    if (value && !available.some((item) => item.id === value))
      available.unshift({ id: value, name: value })
    return (
      <label className="block text-xs text-ink-soft">
        {label}
        <select
          aria-label={`${agentNames[status.client]}: ${label}`}
          className={fieldClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={busy}
        >
          <option value="">{placeholder}</option>
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
      className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-ink">
          {agentNames[status.client]}
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
        {(status.client === 'claude' || status.client === 'codex') && (
          <>
            {chooseModel(t('clients.model'), model, setModel)}
            {status.client === 'claude' && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  {chooseModel(
                    t('clients.fableModel'),
                    fableModel,
                    setFableModel,
                    t('clients.sameModel'),
                  )}
                  {chooseModel(
                    t('clients.opusModel'),
                    opusModel,
                    setOpusModel,
                    t('clients.sameModel'),
                  )}
                  {chooseModel(
                    t('clients.sonnetModel'),
                    sonnetModel,
                    setSonnetModel,
                    t('clients.sameModel'),
                  )}
                  {chooseModel(
                    t('clients.smallModel'),
                    smallModel,
                    setSmallModel,
                    t('clients.sameModel'),
                  )}
                </div>
                {chooseModel(
                  t('clients.reviewModel'),
                  reviewModel,
                  setReviewModel,
                  t('clients.clientDefault'),
                  [
                    { id: 'codex-auto-review', name: 'codex-auto-review' },
                    ...models.filter((item) => item.id !== 'codex-auto-review'),
                  ],
                )}
              </>
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
                onChange={(event) => setNativeToolSearch(event.target.checked)}
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
        {status.client === 'harness' && (
          <>
            <label className="block text-xs text-ink-soft">
              {t('clients.profile')}
              <input
                className={fieldClass}
                list="harness-profiles"
                value={profile}
                onChange={(event) => setProfile(event.target.value)}
              />
              <datalist id="harness-profiles">
                {profiles.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <p className="text-xs leading-5 text-ink-faint">
              {t('clients.harnessHint')}
            </p>
          </>
        )}
      </fieldset>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          className={primaryClass}
          disabled={
            busy
            || !!checkState
            || ((status.client === 'claude' || status.client === 'codex')
              && !model)
            || (status.client === 'harness' && !/^[\w-]{1,80}$/.test(profile))
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
          {pluginFailure && (
            <>
              <code className="mt-2 block break-all whitespace-pre-wrap rounded-lg bg-sunken px-3 py-2 font-mono text-ink-soft">
                {pluginFailure.command}
              </code>
              {pluginFailure.exitCode && (
                <span className="mt-1 block">
                  {t('clients.commandExit', { code: pluginFailure.exitCode })}
                </span>
              )}
            </>
          )}
        </p>
      )}
    </section>
  )
}
