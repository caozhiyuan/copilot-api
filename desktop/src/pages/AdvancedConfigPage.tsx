import { useEffect, useMemo, useState } from 'react'
import ConfigFieldEditor from '../components/ConfigFieldEditor'
import { useLanguage } from '../contexts/LanguageContext'
import {
  getConfigChanges,
  getConfigValidation,
  getConfigValue,
  isConfigObject,
  maskConfigValue,
  mergeConfigDraft,
  parseConfigContent,
  serializeConfig,
  setConfigValue,
  type ConfigObject,
} from '../lib/config-editor'
import {
  ConfigEditorError,
  unwrapConfigEditorReply,
  type ConfigEditorErrorCode,
} from '../lib/config-editor-errors'
import {
  configFields,
  configSections,
  type ConfigSection,
} from '../lib/config-fields'
import {
  buildModelMappingsFromRows,
  modelMappingsToRows,
  type ModelMappingRow,
} from '../lib/model-mappings-editor'
import type { AppConfigDocument, AppConfigSaveResult } from '../types/ipc'
import ModelMappingsPage from './ModelMappingsPage'

const buttonClass =
  'rounded-md border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-40'
const primaryClass =
  'rounded-md bg-accent-strong px-4 py-1.5 text-[13px] font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-blue-500'

function inspect(content: string, baselineContent?: string) {
  let config: ConfigObject | null = null
  let error = ''
  let warnings: string[] = []
  try {
    config = parseConfigContent(content)
    warnings = getConfigValidation(content, baselineContent).warnings
  } catch (err) {
    error = (err as Error).message
  }
  return { config, error, warnings }
}
function mappingRows(
  config: ConfigObject,
  defaults: ConfigObject,
): ModelMappingRow[] {
  const value = config.modelMappings ?? defaults.modelMappings
  if (!isConfigObject(value)) return []
  return modelMappingsToRows(
    Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  )
}

export default function AdvancedConfigPage({
  serverRunning,
  active = true,
}: {
  serverRunning: boolean
  active?: boolean
}) {
  const { t } = useLanguage()
  const [document, setDocument] = useState<AppConfigDocument | null>(null)
  const [content, setContent] = useState('{}\n')
  const [section, setSection] = useState<ConfigSection>('general')
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [showSecrets, setShowSecrets] = useState(false)
  const [rows, setRows] = useState<ModelMappingRow[]>([])
  const [mappingError, setMappingError] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [saveResult, setSaveResult] = useState<AppConfigSaveResult | null>(null)
  const [showChanges, setShowChanges] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [merged, setMerged] = useState(false)
  const [pendingMerge, setPendingMerge] = useState<{
    document: AppConfigDocument
    mine: ConfigObject
    disk: ConfigObject
    conflicts: string[]
  } | null>(null)
  const draft = useMemo(
    () => inspect(content, document?.content),
    [content, document?.content],
  )
  const baseline = useMemo(() => inspect(document?.content ?? '{}'), [document])
  const defaults = useMemo(
    () => parseConfigContent(document?.defaultContent ?? '{}'),
    [document],
  )
  const changes = useMemo(
    () =>
      baseline.config && draft.config ?
        getConfigChanges(baseline.config, draft.config)
      : [],
    [baseline, draft],
  )
  const dirty = !!document && (content !== document.content || !!mappingError)
  const validationError = draft.error || mappingError
  const errorMessage = (err: unknown, fallback: ConfigEditorErrorCode) => {
    if (err instanceof ConfigEditorError) {
      if (err.code === 'validation')
        return `${t('configEditor.invalid')}: ${err.message}`
      return t(`configEditor.errors.${err.code}`)
    }
    return t(`configEditor.errors.${fallback}`)
  }

  const acceptDocument = (next: AppConfigDocument) => {
    setDocument(next)
    setContent(next.content)
    const config = inspect(next.content).config
    setRows(
      config ?
        mappingRows(config, parseConfigContent(next.defaultContent))
      : [],
    )
    setMappingError('')
    setShowChanges(false)
    setConflict(false)
    setPendingMerge(null)
    setMerged(false)
    if (!config) setMode('json')
  }
  const load = async () => {
    setBusy(true)
    setError('')
    setSaveResult(null)
    try {
      acceptDocument(
        unwrapConfigEditorReply(await window.electronAPI.getAppConfig()),
      )
    } catch (err) {
      setError(errorMessage(err, 'readFailed'))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!active || dirty) return
    let current = true
    setBusy(true)
    setError('')
    setSaveResult(null)
    void window.electronAPI
      .getAppConfig()
      .then((next) => {
        if (current) acceptDocument(unwrapConfigEditorReply(next))
      })
      .catch((err: unknown) => {
        if (current) setError(errorMessage(err, 'readFailed'))
      })
      .finally(() => {
        if (current) setBusy(false)
      })
    return () => {
      current = false
    }
    // Refresh on entry only when there is no local draft to overwrite.
  }, [active])

  const updateContent = (next: string) => {
    setContent(next)
    setError('')
    setSaveResult(null)
    setPendingMerge(null)
    setMerged(false)
  }
  const updateField = (path: string, value: unknown) => {
    if (draft.config)
      updateContent(serializeConfig(setConfigValue(draft.config, path, value)))
  }
  const changeMappings = (nextRows: ModelMappingRow[]) => {
    setRows(nextRows)
    const result = buildModelMappingsFromRows(nextRows)
    if (!result.ok) {
      setMappingError(
        result.reason === 'duplicate' ?
          t('advancedConfig.validationDuplicate', { model: result.model ?? '' })
        : t('advancedConfig.validationIncomplete'),
      )
      return
    }
    setMappingError('')
    updateField('modelMappings', result.modelMappings)
  }
  const resetGroup = () => {
    if (!draft.config) return
    let next = draft.config
    if (section === 'mappings') {
      next = setConfigValue(next, 'modelMappings', undefined)
      setRows(mappingRows(next, defaults))
      setMappingError('')
    } else {
      for (const field of configFields.filter(
        (item) => item.section === section && item.type !== 'secret',
      ))
        next = setConfigValue(next, field.path, undefined)
    }
    updateContent(serializeConfig(next))
  }
  const acceptMerge = (latest: AppConfigDocument, config: ConfigObject) => {
    acceptDocument(latest)
    setContent(serializeConfig(config))
    setRows(mappingRows(config, parseConfigContent(latest.defaultContent)))
    setError('')
    setSaveResult(null)
    setMerged(true)
  }
  const recoverDraft = async () => {
    if (!document || !baseline.config || !draft.config || mappingError) return
    setBusy(true)
    try {
      const latest = unwrapConfigEditorReply(
        await window.electronAPI.getAppConfig(),
      )
      const disk = parseConfigContent(latest.content)
      const result = mergeConfigDraft(baseline.config, draft.config, disk)
      if (result.conflicts.length) {
        setPendingMerge({
          document: latest,
          mine: result.config,
          disk: mergeConfigDraft(baseline.config, draft.config, disk, 'disk')
            .config,
          conflicts: result.conflicts,
        })
      } else acceptMerge(latest, result.config)
    } catch (err) {
      setError(errorMessage(err, 'readFailed'))
    } finally {
      setBusy(false)
    }
  }
  const save = async (applyOnly = false) => {
    if (!document || validationError || pendingMerge) return
    setBusy(true)
    setError('')
    setShowChanges(false)
    try {
      const result = unwrapConfigEditorReply(
        applyOnly ?
          await window.electronAPI.applyAppConfig(document.revision)
        : await window.electronAPI.saveAppConfig({
            content,
            revision: document.revision,
          }),
      )
      acceptDocument(result)
      setSaveResult(result)
    } catch (err) {
      setConflict(err instanceof ConfigEditorError && err.code === 'conflict')
      setError(errorMessage(err, applyOnly ? 'applyFailed' : 'saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  const jsonPreview =
    draft.config ?
      JSON.stringify(maskConfigValue(draft.config), null, 2)
    : t('configEditor.maskedUnavailable')
  const displayChange = (value: unknown) =>
    value === undefined ? t('configEditor.inherited') : JSON.stringify(value)

  return (
    <div
      className="flex min-h-full flex-col bg-canvas p-4"
      aria-label={t('configEditor.title')}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold text-ink">
            {t('configEditor.title')}
          </h2>
          <p className="mt-1 break-all font-mono text-[11px] text-ink-soft">
            {document?.configPath ?? t('advancedConfig.configPath')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className={buttonClass}
          >
            {dirty ? t('configEditor.reloadDiscard') : t('configEditor.reload')}
          </button>
          <div
            className="flex rounded-md border border-line bg-sunken p-0.5"
            role="tablist"
            aria-label={t('configEditor.editMode')}
          >
            {(['form', 'json'] as const).map((item) => (
              <button
                type="button"
                key={item}
                role="tab"
                id={`config-mode-${item}`}
                aria-selected={mode === item}
                aria-controls={`config-panel-${item}`}
                disabled={
                  busy
                  || (item === 'form' && !draft.config)
                  || (item === 'json' && !!mappingError)
                }
                onClick={() => {
                  if (mode === item) return
                  if (item === 'form' && draft.config)
                    setRows(mappingRows(draft.config, defaults))
                  setMode(item)
                }}
                className={`rounded px-3 py-1 text-[13px] disabled:opacity-40 ${mode === item ? 'bg-surface text-ink shadow-sm' : 'text-ink-soft'}`}
              >
                {t(item === 'form' ? 'configEditor.form' : 'configEditor.json')}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!serverRunning && (
        <p className="mb-3 rounded-md bg-sunken px-3 py-2 text-[12px] text-ink-soft">
          {t('configEditor.offline')}
        </p>
      )}
      {(error || validationError) && (
        <div
          role="alert"
          className="mb-3 break-words rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-500/15 dark:text-red-400"
        >
          {error || `${t('configEditor.invalid')}: ${validationError}`}
        </div>
      )}
      {draft.warnings.length > 0 && (
        <p className="mb-3 break-words rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
          {t('configEditor.legacyWarning', {
            fields: draft.warnings.join(', '),
          })}
        </p>
      )}
      {conflict && (
        <div className="mb-3 rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-ink-soft">
          {pendingMerge ?
            <>
              <p className="mb-2 break-words">
                {t('configEditor.mergeConflicts', {
                  fields: pendingMerge.conflicts.join(', '),
                })}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass}
                  onClick={() =>
                    acceptMerge(pendingMerge.document, pendingMerge.mine)
                  }
                >
                  {t('configEditor.keepMine')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass}
                  onClick={() =>
                    acceptMerge(pendingMerge.document, pendingMerge.disk)
                  }
                >
                  {t('configEditor.keepDisk')}
                </button>
              </div>
            </>
          : <button
              type="button"
              disabled={busy || !draft.config || !!mappingError}
              onClick={() => void recoverDraft()}
              className={buttonClass}
            >
              {t('configEditor.mergeLatest')}
            </button>
          }
        </div>
      )}
      {merged && (
        <p
          role="status"
          className="mb-3 rounded-md bg-sunken px-3 py-2 text-[12px] text-ink-soft"
        >
          {t('configEditor.merged')}
        </p>
      )}
      {saveResult && (
        <div
          role="status"
          className={`mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-2 text-[12px] ${saveResult.refreshError ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'}`}
        >
          <span>
            {saveResult.refreshError ?
              `${t('configEditor.savedNotApplied')}: ${saveResult.refreshError}`
            : saveResult.applied ?
              t('configEditor.savedApplied')
            : t('configEditor.savedOffline')}
          </span>
          {saveResult.refreshError && (
            <button
              type="button"
              disabled={busy || dirty || !serverRunning}
              onClick={() => void save(true)}
              className={buttonClass}
            >
              {t('configEditor.retryApply')}
            </button>
          )}
        </div>
      )}
      <div
        id="config-panel-form"
        role="tabpanel"
        aria-labelledby="config-mode-form"
        hidden={mode !== 'form'}
        className="grid min-w-0 gap-4 md:grid-cols-[156px_minmax(0,1fr)]"
      >
        <nav
          aria-label={t('configEditor.groupsLabel')}
          className="flex flex-wrap content-start gap-1 md:flex-col md:border-r md:border-line md:pr-3"
        >
          {configSections.map((item) => (
            <button
              type="button"
              key={item}
              disabled={busy}
              aria-current={section === item ? 'page' : undefined}
              onClick={() => setSection(item)}
              className={`rounded-md px-3 py-2 text-left text-[13px] ${section === item ? 'bg-accent-soft font-medium text-ink' : 'text-ink-soft hover:bg-sunken'}`}
            >
              {t(`configEditor.groups.${item}`)}
            </button>
          ))}
          <p className="mt-3 w-full px-3 text-[11px] leading-relaxed text-ink-soft">
            {t('configEditor.otherSettings')}
          </p>
        </nav>
        <section className="min-w-0 rounded-lg border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h3 className="text-[14px] font-medium text-ink">
              {t(`configEditor.groups.${section}`)}
            </h3>
            <button
              type="button"
              disabled={busy || !document || !draft.config}
              onClick={resetGroup}
              className="text-[11px] text-ink-soft hover:text-ink disabled:opacity-40"
            >
              {t('configEditor.resetGroup')}
            </button>
          </div>
          {busy && !document ?
            <p className="px-4 py-8 text-[13px] text-ink-soft">
              {t('dashboard.loading')}
            </p>
          : section === 'mappings' ?
            <ModelMappingsPage
              rows={rows}
              onChange={changeMappings}
              disabled={busy || !document}
            />
          : configFields
              .filter((field) => field.section === section)
              .map((field) => (
                <ConfigFieldEditor
                  key={field.id}
                  field={field}
                  disabled={busy || !document}
                  value={
                    draft.config ?
                      getConfigValue(draft.config, field.path)
                    : undefined
                  }
                  defaultValue={getConfigValue(defaults, field.path)}
                  onChange={(value) => updateField(field.path, value)}
                />
              ))
          }
        </section>
      </div>
      <section
        id="config-panel-json"
        role="tabpanel"
        aria-labelledby="config-mode-json"
        hidden={mode !== 'json'}
        className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <label className="flex items-center gap-2 text-[12px] text-ink-soft">
            <input
              type="checkbox"
              checked={showSecrets}
              disabled={busy}
              onChange={(e) => setShowSecrets(e.target.checked)}
              className="accent-accent-strong"
            />
            {t('configEditor.showSecrets')}
          </label>
          <button
            type="button"
            disabled={busy || !showSecrets || !draft.config}
            onClick={() => {
              if (draft.config) updateContent(serializeConfig(draft.config))
            }}
            className={buttonClass}
          >
            {t('configEditor.format')}
          </button>
        </div>
        <textarea
          aria-label={t('configEditor.jsonContent')}
          value={showSecrets ? content : jsonPreview}
          readOnly={!showSecrets || busy}
          spellCheck={false}
          rows={21}
          onChange={(e) => updateContent(e.target.value)}
          className="block w-full resize-y whitespace-pre-wrap break-all border-0 bg-sunken p-4 font-mono text-[12px] leading-relaxed text-ink focus:ring-2 focus:ring-inset focus:ring-accent/40"
        />
        <p className="border-t border-line px-4 py-2 text-[11px] text-ink-soft">
          {showSecrets ?
            t('configEditor.sharedDraft')
          : t('configEditor.maskedReadOnly')}
        </p>
      </section>
      {showChanges && (
        <section
          aria-label={t('configEditor.review')}
          className="mt-4 rounded-lg border border-line bg-surface"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <h3 className="text-[13px] font-medium text-ink">
              {t('configEditor.review')}
            </h3>
            <button
              type="button"
              onClick={() => setShowChanges(false)}
              className={buttonClass}
            >
              {t('configEditor.close')}
            </button>
          </div>
          {changes.map((change) => (
            <div
              key={change.path}
              className="border-b border-line-soft px-4 py-3 last:border-0"
            >
              <div className="break-all font-mono text-[11px] text-ink-soft">
                {change.path}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px]">
                <span className="break-all text-ink-soft line-through">
                  {displayChange(change.before)}
                </span>
                <span aria-hidden="true">→</span>
                <span className="break-all text-ink">
                  {displayChange(change.after)}
                </span>
              </div>
            </div>
          ))}
        </section>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span
          aria-live="polite"
          className={`mr-auto text-[12px] ${dirty ? 'text-amber-700 dark:text-amber-300' : 'text-ink-soft'}`}
        >
          {dirty && changes.length ?
            t('configEditor.unsaved', { count: changes.length })
          : dirty ?
            t('configEditor.unsavedOther')
          : t('configEditor.synced')}
        </span>
        <button
          type="button"
          disabled={busy || !dirty || !document}
          onClick={() => {
            if (document) {
              acceptDocument(document)
              setError('')
              setSaveResult(null)
            }
          }}
          className={buttonClass}
        >
          {t('configEditor.discard')}
        </button>
        <button
          type="button"
          disabled={busy || !changes.length || !!validationError}
          onClick={() => setShowChanges(!showChanges)}
          className={buttonClass}
        >
          {t('configEditor.review')}
        </button>
        <button
          type="button"
          disabled={
            busy || !dirty || !document || !!validationError || !!pendingMerge
          }
          onClick={() => void save()}
          className={primaryClass}
        >
          {busy && document ?
            t('settings.saving')
          : serverRunning ?
            t('configEditor.saveApply')
          : t('configEditor.save')}
        </button>
      </div>
    </div>
  )
}
