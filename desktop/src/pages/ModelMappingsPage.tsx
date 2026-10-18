import { useLanguage } from '../contexts/LanguageContext'
import {
  createModelMappingRow,
  type ModelMappingRow,
} from '../lib/model-mappings-editor'

interface ModelMappingsPageProps {
  rows: ModelMappingRow[]
  onChange: (rows: ModelMappingRow[]) => void
  disabled?: boolean
}

// Controlled by AdvancedConfigPage so mapping changes share its JSON draft,
// validation, revision check and save/apply result.
export default function ModelMappingsPage({
  rows,
  onChange,
  disabled,
}: ModelMappingsPageProps) {
  const { t } = useLanguage()
  const changeRow = (id: string, field: 'source' | 'target', value: string) => {
    onChange(
      rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    )
  }
  return (
    <div>
      <div className="flex flex-col items-start gap-3 border-b border-line-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[12px] leading-relaxed text-ink-soft">
          {t('advancedConfig.modelMappingsDesc')}
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...rows, createModelMappingRow()])}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink-soft transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/20 disabled:opacity-50"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t('advancedConfig.addMapping')}
        </button>
      </div>
      {rows.map((row) => (
        <div
          key={row.id}
          className="grid gap-2 border-b border-line-soft px-4 py-3 transition-colors hover:bg-sunken/50 sm:grid-cols-[minmax(0,1fr)_20px_minmax(0,1fr)_auto]"
        >
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-ink-soft">
              {t('advancedConfig.sourceModel')}
            </span>
            <input
              value={row.source}
              disabled={disabled}
              onChange={(e) => changeRow(row.id, 'source', e.target.value)}
              placeholder="gpt-5.5"
              className="w-full min-w-0 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink transition-colors focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/15 disabled:opacity-50"
            />
          </label>
          <span
            aria-hidden="true"
            className="hidden h-9 items-center justify-center self-end text-ink-faint sm:flex"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 12h16m-6-6 6 6-6 6" />
            </svg>
          </span>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-ink-soft">
              {t('advancedConfig.targetModel')}
            </span>
            <input
              value={row.target}
              disabled={disabled}
              onChange={(e) => changeRow(row.id, 'target', e.target.value)}
              placeholder="codex/gpt-5.5"
              className="w-full min-w-0 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-[13px] text-ink transition-colors focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/15 disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
            className="self-end rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-soft transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/25 disabled:opacity-50 dark:hover:border-rose-500/25 dark:hover:bg-rose-500/10 dark:hover:text-rose-400"
          >
            {t('advancedConfig.remove')}
          </button>
        </div>
      ))}
      <p className="bg-sunken px-4 py-3 text-[11px] leading-relaxed text-ink-soft">
        {t('configEditor.mappingDefaults')}
      </p>
    </div>
  )
}
