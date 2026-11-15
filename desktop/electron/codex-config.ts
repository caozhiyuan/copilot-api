import {
  getStaticTOMLValue,
  parseForESLint,
  type AST,
} from 'toml-eslint-parser'
import { readTomlConfig } from './client-config'

// Keep the managed fields in docs/guides/en/codex.md reference order.
const order: Record<string, string[]> = {
  '': [
    'model',
    'model_reasoning_effort',
    'model_provider',
    'model_reasoning_summary',
    'plan_mode_reasoning_effort',
    'model_context_window',
    'sandbox_mode',
    'approvals_reviewer',
    'suppress_unstable_features_warning',
    'web_search',
    'service_tier',
    'model_catalog_json',
  ],
  'model_providers.copilot_api': [
    'name',
    'base_url',
    'model_catalog_url',
    'env_key',
    'requires_openai_auth',
    'supports_websockets',
    'supports_standalone_web_search',
    'wire_api',
    'request_max_retries',
    'stream_max_retries',
    'stream_idle_timeout_ms',
  ],
  features: [
    'remote_compaction_v2',
    'api_key_model_discovery',
    'default_mode_request_user_input',
    'standalone_web_search',
    'daemon_auto_start',
    'prevent_idle_sleep',
    'defer_mailbox_preemption',
    'instant_interrupt',
  ],
  desktop: ['enabled-reasoning-efforts'],
  analytics: ['enabled'],
}
interface Row {
  key: string
  text: string
}

/** Reorder managed source slices without reserializing values or user tables. */
export function formatCodexConfig(content: string): string {
  let ast: AST.TOMLProgram
  try {
    ast = parseForESLint(content).ast
  } catch {
    throw new Error('invalidConfig')
  }
  const statements = ast.body[0].body
  if (!statements.length) return content
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const clean = (text: string) =>
    text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()
  const startOf = (position: number, floor: number, comments = true) => {
    let start = content.lastIndexOf('\n', position - 1) + 1
    while (comments && start > floor) {
      const previous = content.lastIndexOf('\n', start - 2) + 1
      if (
        previous < floor
        || !content.slice(previous, start).trim().startsWith('#')
      )
        break
      start = previous
    }
    return start
  }
  const starts = statements.map((node, index) =>
    startOf(
      node.range[0],
      index ? statements[index - 1].range[1] : 0,
      index > 0,
    ),
  )
  const groups = new Map<string, { header: string; rows: Row[] }>(
    Object.keys(order).map((name) => [name, { header: '', rows: [] }]),
  )
  const otherTables: string[] = []
  for (let index = 0; index < statements.length; index++) {
    const node = statements[index]
    const start = starts[index]
    const end = starts[index + 1] ?? content.length
    if (node.type === 'TOMLKeyValue') {
      const keys = getStaticTOMLValue(node.key)
      const section =
        Object.keys(order).find(
          (name) =>
            name
            && keys.length > name.split('.').length
            && name
              .split('.')
              .every((part, partIndex) => keys[partIndex] === part),
        ) ?? ''
      const relative = section ? keys.slice(section.split('.').length) : keys
      const key = relative
        .map((part) => (/^[\w-]+$/.test(part) ? part : JSON.stringify(part)))
        .join('.')
      groups.get(section)!.rows.push({
        key: relative.join('.'),
        text:
          section ?
            content.slice(start, node.key.range[0])
            + key
            + content.slice(node.key.range[1], end)
          : content.slice(start, end),
      })
      continue
    }
    const name = node.resolvedKey.join('.')
    const group = node.kind === 'standard' ? groups.get(name) : undefined
    if (!group) {
      otherTables.push(content.slice(start, end))
      continue
    }
    const close = content.indexOf(']', node.key.range[1])
    const rowStarts = node.body.map((row, rowIndex) =>
      startOf(
        row.range[0],
        rowIndex ? node.body[rowIndex - 1].range[1] : close + 1,
      ),
    )
    group.header =
      content.slice(start, node.range[0])
      + `[${name}]`
      + content.slice(close + 1, rowStarts[0] ?? end)
    node.body.forEach((row: AST.TOMLKeyValue, rowIndex) =>
      group.rows.push({
        key: getStaticTOMLValue(row.key).join('.'),
        text: content.slice(
          rowStarts[rowIndex],
          rowStarts[rowIndex + 1] ?? end,
        ),
      }),
    )
  }
  const blocks = [content.slice(0, starts[0])]
  for (const [name, group] of groups) {
    if (!group.rows.length && !group.header) continue
    const rank = (key: string) => {
      const index = order[name].indexOf(key)
      return index < 0 ? Infinity : index
    }
    group.rows.sort((a, b) => rank(a.key) - rank(b.key))
    blocks.push(
      [
        clean(group.header || (name ? `[${name}]` : '')),
        ...group.rows.map((row) => clean(row.text)),
      ]
        .filter(Boolean)
        .join(eol),
    )
  }
  const result =
    [...blocks, ...otherTables]
      .map(clean)
      .filter(Boolean)
      .join(eol + eol) + eol
  readTomlConfig(result)
  return result
}
