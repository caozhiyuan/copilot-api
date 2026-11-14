import { describe, expect, test } from 'bun:test'
import {
  buildModelMappingsFromRows,
  createModelMappingRow,
  mergeModelMappingRows,
  modelMappingsToRows,
} from '../src/lib/model-mappings-editor'

describe('model mapping presets', () => {
  test('updates matching rows in place and appends missing rules without duplicates', () => {
    const rows = modelMappingsToRows({ existing: 'old', alias: 'custom/model' })
    const mappings = { existing: 'codex/existing', added: 'codex/added' }
    const next = mergeModelMappingRows(rows, mappings)
    expect(next[0]).toEqual({ ...rows[0], target: 'codex/existing' })
    expect(next[1]).toBe(rows[1])
    expect(mergeModelMappingRows(next, mappings)).toEqual(next)
    expect(buildModelMappingsFromRows(next)).toEqual({
      ok: true,
      modelMappings: { ...mappings, alias: 'custom/model' },
    })
    expect(rows[0].target).toBe('old')
  })

  test('adds mappings to an empty draft and preserves incomplete edits for validation', () => {
    expect(
      buildModelMappingsFromRows(mergeModelMappingRows([], { a: 'b' })),
    ).toEqual({ ok: true, modelMappings: { a: 'b' } })
    const blank = createModelMappingRow()
    const incomplete = createModelMappingRow('unfinished')
    const next = mergeModelMappingRows([blank, incomplete], { a: 'b' })
    expect(next.slice(0, 2)).toEqual([blank, incomplete])
    expect(buildModelMappingsFromRows([blank])).toEqual({
      ok: true,
      modelMappings: {},
    })
    expect(buildModelMappingsFromRows(next)).toEqual({
      ok: false,
      reason: 'incomplete',
    })
  })

  test('keeps duplicate user edits invalid instead of silently discarding them', () => {
    const rows = [
      createModelMappingRow('a', 'first'),
      createModelMappingRow('a', 'second'),
    ]
    expect(
      buildModelMappingsFromRows(mergeModelMappingRows(rows, { a: 'b' })),
    ).toEqual({ ok: false, reason: 'duplicate', model: 'a' })
    expect(mergeModelMappingRows(rows, {})).toEqual(rows)
  })
})
