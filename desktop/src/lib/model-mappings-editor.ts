export interface ModelMappingRow {
  id: string
  source: string
  target: string
}

export type ModelMappingsValidationResult =
  | {
      modelMappings: Record<string, string>
      ok: true
    }
  | {
      model?: string
      ok: false
      reason: 'duplicate' | 'incomplete'
    }

function createModelMappingRowId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function createModelMappingRow(
  source = '',
  target = '',
  id = createModelMappingRowId(),
): ModelMappingRow {
  return {
    id,
    source,
    target,
  }
}

export function modelMappingsToRows(
  modelMappings: Record<string, string>,
): ModelMappingRow[] {
  return Object.entries(modelMappings).map(([source, target]) =>
    createModelMappingRow(source, target),
  )
}

export function mergeModelMappingRows(
  rows: ModelMappingRow[],
  modelMappings: Record<string, string>,
): ModelMappingRow[] {
  const pending = new Map(Object.entries(modelMappings))
  const next = rows.map((row) => {
    const target = pending.get(row.source)
    if (target === undefined) return row
    pending.delete(row.source)
    return { ...row, target }
  })
  return [...next, ...modelMappingsToRows(Object.fromEntries(pending))]
}

export function buildModelMappingsFromRows(
  rows: ModelMappingRow[],
): ModelMappingsValidationResult {
  const modelMappings: Record<string, string> = {}

  for (const row of rows) {
    if (!row.source && !row.target) {
      continue
    }

    if (!row.source || !row.target) {
      return { ok: false, reason: 'incomplete' }
    }

    if (Object.hasOwn(modelMappings, row.source)) {
      return { ok: false, model: row.source, reason: 'duplicate' }
    }

    modelMappings[row.source] = row.target
  }

  return { modelMappings, ok: true }
}
