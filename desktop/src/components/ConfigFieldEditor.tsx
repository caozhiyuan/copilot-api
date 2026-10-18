import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import type { ConfigField } from '../lib/config-fields'

const inputClass =
  'w-full min-w-0 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink transition-colors hover:border-blue-200 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/15 disabled:opacity-50 dark:hover:border-blue-500/30'

export default function ConfigFieldEditor({
  field,
  value,
  defaultValue,
  disabled,
  onChange,
}: {
  field: ConfigField
  value: unknown
  defaultValue: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  const { t } = useLanguage()
  const inherited = value === undefined
  const sourceClass = `inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${inherited ? 'bg-sunken text-ink-soft ring-line' : 'bg-slate-100 text-slate-600 ring-slate-200/80 dark:bg-slate-500/10 dark:text-slate-300 dark:ring-slate-500/20'}`
  const effective = inherited ? defaultValue : value
  const [editing, setEditing] = useState<string | null>(null)
  const emitted = useRef<string>()
  const fingerprint = JSON.stringify(value)
  useEffect(() => {
    if (fingerprint !== emitted.current) setEditing(null)
  }, [fingerprint])
  const edit = (text: string, next: unknown) => {
    emitted.current = JSON.stringify(next)
    setEditing(text)
    onChange(next)
  }
  const id = `config-${field.id}`
  const label = t(`configEditor.fields.${field.id}.label`)
  const stringValue =
    editing
    ?? (typeof effective === 'string' || typeof effective === 'number' ?
      effective
    : '')
  return (
    <div className="grid gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-0 hover:bg-sunken/50 sm:grid-cols-[minmax(0,1fr)_minmax(150px,240px)] sm:items-center">
      <div className="min-w-0">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-soft">
          {t(`configEditor.fields.${field.id}.description`)}
        </p>
        <div className="mt-1 inline-block max-w-full break-all rounded bg-sunken px-1.5 py-0.5 font-mono text-[10px] text-ink-soft">
          {field.path}
        </div>
      </div>
      <div className="min-w-0">
        {field.type === 'boolean' ?
          <div className="flex items-center justify-between gap-2 sm:justify-end">
            <span className={sourceClass}>
              {inherited ?
                t('configEditor.inherited')
              : t('configEditor.explicit')}
            </span>
            <label className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center">
              <input
                id={id}
                type="checkbox"
                role="switch"
                checked={effective === true}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                className="peer sr-only"
              />
              <span className="absolute inset-0 rounded-full bg-line transition-colors peer-checked:bg-emerald-500 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500/25 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface peer-disabled:opacity-50" />
              <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
            </label>
          </div>
        : field.type === 'json' ?
          <textarea
            id={id}
            value={
              editing
              ?? (typeof effective === 'string' ? effective : (
                JSON.stringify(effective ?? {}, null, 2)
              ))
            }
            rows={3}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => {
              try {
                edit(e.target.value, JSON.parse(e.target.value) as unknown)
              } catch {
                edit(e.target.value, e.target.value)
              }
            }}
            onBlur={() => setEditing(null)}
            className={`${inputClass} font-mono text-[12px]`}
          />
        : field.type === 'model' ?
          <div className="space-y-2">
            <select
              id={id}
              value={
                editing !== null ? 'custom'
                : inherited ?
                  'default'
                : value === '' ?
                  'off'
                : 'custom'
              }
              disabled={disabled}
              onChange={(e) => {
                setEditing(null)
                onChange(
                  e.target.value === 'default' ? undefined
                  : e.target.value === 'off' ? ''
                  : 'codex-auto-review',
                )
              }}
              className={inputClass}
            >
              <option value="default">
                {t('configEditor.autoModelDefault')}
              </option>
              <option value="off">{t('configEditor.autoModelOff')}</option>
              <option value="custom">
                {t('configEditor.autoModelCustom')}
              </option>
            </select>
            {(editing !== null || (!inherited && value !== '')) && (
              <input
                aria-label={t('configEditor.autoModelCustom')}
                value={stringValue}
                disabled={disabled}
                onChange={(e) => edit(e.target.value, e.target.value)}
                onBlur={() => setEditing(null)}
                className={inputClass}
              />
            )}
          </div>
        : <div className="flex min-w-0 items-center gap-2">
            <input
              id={id}
              type={
                field.type === 'number' ? 'number'
                : field.type === 'secret' ?
                  'password'
                : 'text'
              }
              autoComplete="off"
              value={stringValue}
              disabled={disabled}
              step={'step' in field ? field.step : '1'}
              min={
                field.type === 'number' ?
                  'step' in field ?
                    '0.01'
                  : '1'
                : undefined
              }
              onChange={(e) => {
                if (field.type === 'number')
                  edit(
                    e.target.value,
                    e.target.value === '' ? undefined : Number(e.target.value),
                  )
                else onChange(e.target.value)
              }}
              onBlur={() => setEditing(null)}
              className={inputClass}
            />
            {'unit' in field && (
              <span className="text-[11px] text-ink-soft">{field.unit}</span>
            )}
          </div>
        }
        {field.type !== 'boolean' && (
          <div className="mt-1.5">
            <span className={sourceClass}>
              {inherited ?
                t('configEditor.inherited')
              : t('configEditor.explicit')}
            </span>
          </div>
        )}
        {!inherited && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setEditing(null)
              onChange(undefined)
            }}
            className="mt-1 text-[11px] text-blue-600 underline decoration-blue-200 underline-offset-2 hover:text-blue-700 disabled:opacity-50 dark:text-blue-400 dark:decoration-blue-500/30 dark:hover:text-blue-300"
          >
            {t('configEditor.useDefault')}
          </button>
        )}
      </div>
    </div>
  )
}
