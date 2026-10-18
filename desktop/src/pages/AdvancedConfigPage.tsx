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
  'rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40'
const primaryClass =
  'inline-flex h-8 items-center rounded-lg bg-accent-strong px-4 text-[13px] font-semibold text-white shadow-sm transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none dark:bg-blue-500'

const sectionIconPaths: Record<ConfigSection, string> = {
  mappings: 'M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4',
  general: 'M4 7h16M4 17h16M8 4v6M16 14v6',
  models: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5',
  search: 'm21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  transport: 'M12 8v4M6 16v-4h12v4M8 3h8v5H8zM3 16h6v5H3zm12 0h6v5h-6z',
}

function ConfigSectionIcon({ section }: { section: ConfigSection }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={sectionIconPaths[section]} />
    </svg>
  )
}

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
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto inline-flex items-center gap-2.5 text-[16px] font-semibold text-ink">
            <span className="text-ink-soft">
              <ConfigSectionIcon section="general" />
            </span>
            {t('configEditor.title')}
          </h2>
          <span
            aria-live="polite"
            className="text-[12px] text-amber-700 dark:text-amber-300"
          >
            {dirty
              && (changes.length ?
                t('configEditor.unsaved', { count: changes.length })
              : t('configEditor.unsavedOther'))}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className={buttonClass}
          >
            {dirty ? t('configEditor.reloadDiscard') : t('configEditor.reload')}
          </button>
          <div
            className="flex rounded-lg border border-line bg-sunken p-0.5"
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
                className={`rounded-md px-3 py-1 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 disabled:opacity-40 ${mode === item ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}
              >
                {t(item === 'form' ? 'configEditor.form' : 'configEditor.json')}
              </button>
            ))}
          </div>
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
        className="grid min-w-0 items-start gap-4 md:grid-cols-[200px_minmax(0,1fr)]"
      >
        <nav
          aria-label={t('configEditor.groupsLabel')}
          className="flex min-w-0 flex-wrap content-start gap-1 rounded-xl border border-line-soft bg-surface p-2 md:flex-col"
        >
          {configSections.map((item) => (
            <button
              type="button"
              key={item}
              disabled={busy}
              aria-current={section === item ? 'page' : undefined}
              onClick={() => setSection(item)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40 ${section === item ? 'bg-sunken font-semibold text-ink' : 'text-ink-soft hover:bg-sunken/60'}`}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${section === item ? 'border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-400' : 'border-line bg-canvas text-ink-faint'}`}
              >
                <ConfigSectionIcon section={item} />
              </span>
              {t(`configEditor.groups.${item}`)}
            </button>
          ))}
        </nav>
        <section className="min-w-0 overflow-hidden rounded-xl border border-line-soft bg-surface shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
            <h3 className="inline-flex items-center gap-2.5 text-[14px] font-semibold text-ink">
              <span className="text-ink-soft">
                <ConfigSectionIcon section={section} />
              </span>
              {t(`configEditor.groups.${section}`)}
            </h3>
            <button
              type="button"
              disabled={busy || !document || !draft.config}
              onClick={resetGroup}
              className="rounded-md px-2 py-1 text-[11px] text-ink-soft transition-colors hover:bg-surface hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-40 dark:hover:text-blue-300"
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
        className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken px-4 py-2">
          <label className="flex items-center gap-2 text-[12px] text-ink-soft">
            <input
              type="checkbox"
              checked={showSecrets}
              disabled={busy}
              onChange={(e) => setShowSecrets(e.target.checked)}
              className="accent-blue-600"
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
          className="block w-full resize-y whitespace-pre-wrap break-all border-0 bg-sunken p-4 font-mono text-[12px] leading-relaxed text-ink focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500/25"
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
    </div>
  )
}
