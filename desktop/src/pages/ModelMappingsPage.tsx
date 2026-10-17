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
      <p className="border-b border-line-soft px-4 py-3 text-[12px] text-ink-soft">
        {t('advancedConfig.modelMappingsDesc')}
      </p>
      {rows.map((row) => (
        <div
          key={row.id}
          className="grid gap-2 border-b border-line-soft px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
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
              className="w-full rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[13px] text-ink focus:ring-2 focus:ring-accent/40"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[12px] text-ink-soft">
              {t('advancedConfig.targetModel')}
            </span>
            <input
              value={row.target}
              disabled={disabled}
              onChange={(e) => changeRow(row.id, 'target', e.target.value)}
              placeholder="codex/gpt-5.5"
              className="w-full rounded-md border border-line bg-sunken px-2.5 py-1.5 text-[13px] text-ink focus:ring-2 focus:ring-accent/40"
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
            className="self-end rounded-md border border-line px-2.5 py-1.5 text-[13px] text-ink-soft hover:bg-sunken disabled:opacity-50"
          >
            {t('advancedConfig.remove')}
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <p className="text-[12px] text-ink-soft">
          {t('configEditor.mappingDefaults')}
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...rows, createModelMappingRow()])}
          className="rounded-md border border-line px-3 py-1.5 text-[13px] text-ink-soft hover:bg-sunken disabled:opacity-50"
        >
          {t('advancedConfig.addMapping')}
        </button>
      </div>
    </div>
  )
}
