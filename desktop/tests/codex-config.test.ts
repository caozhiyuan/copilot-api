import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { getStaticTOMLValue, parseForESLint } from 'toml-eslint-parser'
import { formatCodexConfig } from '../electron/codex-config'
import { readTomlConfig } from '../electron/client-config'

const guide = fs.readFileSync(
  path.resolve(import.meta.dir, '../../docs/guides/en/codex.md'),
  'utf8',
)
const reference = /```toml\n([\s\S]*?)```/.exec(guide)![1]
const entries = (source: string) =>
  parseForESLint(source).ast.body[0].body.flatMap((node) =>
    node.type === 'TOMLKeyValue' ?
      [
        {
          keys: getStaticTOMLValue(node.key),
          value: source.slice(...node.value.range),
        },
      ]
    : node.body.map((row) => ({
        keys: [...node.resolvedKey, ...getStaticTOMLValue(row.key)],
        value: source.slice(...row.value.range),
      })),
  )
const referenceKeys = entries(reference).map((entry) => entry.keys.join('.'))

test('converts the previous dotted output to sections in codex.md field order', () => {
  const dotted = entries(reference)
    .reverse()
    .map((entry) => entry.keys.join('.') + ' = ' + entry.value)
    .join('\n')
  const result = formatCodexConfig(dotted)
  expect(entries(result).map((entry) => entry.keys.join('.'))).toEqual(
    referenceKeys,
  )
  expect(readTomlConfig(result)).toEqual(readTomlConfig(dotted))
  for (const section of [
    'model_providers.copilot_api',
    'features',
    'desktop',
    'analytics',
  ])
    expect(result).toContain(`[${section}]\n`)
  expect(result).not.toMatch(/^(model_providers|features|desktop|analytics)\./m)
  expect(formatCodexConfig(result)).toBe(result)
})

test('orders existing sections while retaining comments, multiline values and user tables', () => {
  const source =
    '# Header\r\nmodel_provider = "copilot_api"\r\n# Review choice\r\nmodel_reasoning_effort = "high" # keep\r\nmodel = "custom"\r\nnotes = """\r\nfeatures.fake = true\r\n"""\r\n# Metrics\r\n[analytics] # metrics\r\nenabled = true\r\n[projects."/work"]\r\ntrust_level = "trusted"\r\n[[mcp_servers.test]]\r\nvalue = 1\r\n[features]\r\ninstant_interrupt = true\r\n# Compaction\r\nremote_compaction_v2 = false\r\n[model_providers."copilot_api"] # gateway\r\nwire_api = "responses"\r\nname = "Custom"\r\n'
  const result = formatCodexConfig(source)
  expect(readTomlConfig(result)).toEqual(readTomlConfig(source))
  expect(result).toContain(
    '# Review choice\r\nmodel_reasoning_effort = "high" # keep',
  )
  expect(result).toContain('[model_providers.copilot_api] # gateway')
  expect(result).toContain('# Metrics\r\n[analytics] # metrics')
  expect(result).toContain('notes = """\r\nfeatures.fake = true\r\n"""')
  expect(result).toContain('[projects."/work"]\r\ntrust_level = "trusted"')
  expect(result.indexOf('[features]')).toBeLessThan(
    result.indexOf('[analytics]'),
  )
  expect(result.indexOf('remote_compaction_v2')).toBeLessThan(
    result.indexOf('instant_interrupt'),
  )
  expect(formatCodexConfig(result)).toBe(result)
})

test('preserves empty tables and existing inline tables instead of losing user values', () => {
  for (const source of [
    '',
    '# only a comment\n',
    '[features]',
    'features = { keep = true }\nmodel = "gpt"',
    'model_providers.other.name = "Other"\nmodel_providers.copilot_api.name = "OpenAI"',
  ]) {
    const result = formatCodexConfig(source)
    expect(readTomlConfig(result)).toEqual(readTomlConfig(source))
    expect(formatCodexConfig(result)).toBe(result)
  }
  expect(() => formatCodexConfig('[broken')).toThrow('invalidConfig')
})
