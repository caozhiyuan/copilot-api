import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { parseEnv } from 'node:util'
import {
  getStaticTOMLValue,
  parseForESLint,
  type AST,
} from 'toml-eslint-parser'

export function readJsonConfig(content: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value: unknown = parse(content.trim() ? content : '{}', errors, {
    allowTrailingComma: true,
  })
  if (errors.length || !isObject(value)) throw new Error('invalidConfig')
  return value
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function patchEnvConfig(
  content: string,
  updates: Record<string, string>,
): string {
  const start = '# >>> copilot-api Harness >>>'
  const end = '# <<< copilot-api Harness <<<'
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = Object.entries(updates).map(([key, value]) => {
    const candidates = ['"', "'", '`'].map(
      (quote) => `${quote}${value}${quote}`,
    )
    candidates.push(value)
    const quoted = candidates.find(
      (candidate) => parseEnv(`${key}=${candidate}`)[key] === value,
    )
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || quoted === undefined)
      throw new Error('invalidInput')
    return `${key}=${quoted}`
  })
  const block = [start, ...lines, end].join(eol)
  const first = content.indexOf(start)
  const last = content.indexOf(end)
  let result: string
  if (first < 0 && last < 0)
    result =
      content + (content && !content.endsWith('\n') ? eol : '') + block + eol
  else if (first < 0 || last < first) throw new Error('invalidConfig')
  else
    result = content.slice(0, first) + block + content.slice(last + end.length)
  const parsed = parseEnv(result)
  if (Object.entries(updates).some(([key, value]) => parsed[key] !== value))
    throw new Error('invalidConfig')
  return result
}

export function patchJsonConfig(
  content: string,
  updates: Array<[string[], unknown]>,
): string {
  readJsonConfig(content)
  let result = content.trim() ? content : '{}\n'
  for (const [keys, value] of updates) {
    result = applyEdits(
      result,
      modify(result, keys, value, {
        formattingOptions: {
          insertSpaces: !/^\t/m.test(result),
          tabSize:
            /^ +"/m.exec(result)?.[0].length ?
              /^ +/m.exec(result)![0].length
            : 2,
          eol: result.includes('\r\n') ? '\r\n' : '\n',
        },
      }),
    )
  }
  readJsonConfig(result)
  return result
}

export function readTomlConfig(content: string): Record<string, unknown> {
  try {
    return getStaticTOMLValue(parseForESLint(content).ast)
  } catch {
    throw new Error('invalidConfig')
  }
}

type Scalar = string | number | boolean | string[]
const keyText = (key: string) =>
  /^[\w-]+$/.test(key) ? key : JSON.stringify(key)
const startsWith = (
  keys: Array<string | number>,
  prefix: Array<string | number>,
) => prefix.every((key, index) => key === keys[index])

// Edit AST value ranges rather than reserializing TOML: comments, formatting,
// quoted/dotted keys, inline tables and unrelated settings survive unchanged.
export function patchTomlConfig(
  content: string,
  updates: Array<[string[], Scalar]>,
): string {
  let result = content
  for (const [keys, value] of updates) {
    let ast: AST.TOMLProgram
    try {
      ast = parseForESLint(result).ast
    } catch {
      throw new Error('invalidConfig')
    }
    let found: AST.TOMLKeyValue | undefined
    let inline: { node: AST.TOMLInlineTable; prefix: string[] } | undefined
    let table: AST.TOMLTable | undefined
    const visit = (node: AST.TOMLKeyValue, prefix: string[]) => {
      const current = [...prefix, ...getStaticTOMLValue(node.key)]
      if (!startsWith(keys, current)) return
      if (current.length === keys.length) {
        found = node
      } else if (node.value.type === 'TOMLInlineTable') {
        inline = { node: node.value, prefix: current }
        node.value.body.forEach((child) => visit(child, current))
      } else {
        throw new Error('invalidConfig')
      }
    }
    const statements = ast.body[0].body
    for (const statement of statements) {
      if (statement.type === 'TOMLKeyValue') visit(statement, [])
      else if (startsWith(keys, statement.resolvedKey)) {
        if (statement.kind !== 'standard') throw new Error('invalidConfig')
        if (!table || table.resolvedKey.length < statement.resolvedKey.length)
          table = statement
        statement.body.forEach((node) =>
          visit(node, statement.resolvedKey as string[]),
        )
      }
    }
    const serialized =
      Array.isArray(value) ?
        `[${value.map((entry) => JSON.stringify(entry)).join(', ')}]`
      : JSON.stringify(value)
    if (found) {
      const [start, end] = found.value.range
      result = result.slice(0, start) + serialized + result.slice(end)
      continue
    }
    if (inline) {
      const { node, prefix } = inline
      const entry = `${keys.slice(prefix.length).map(keyText).join('.')} = ${serialized}`
      const index = node.range[1] - 1
      const separator = node.body.length ? ', ' : ' '
      result =
        result.slice(0, index) + separator + entry + ' ' + result.slice(index)
      continue
    }
    const tables = statements.filter((node) => node.type === 'TOMLTable')
    const next = table ? tables[tables.indexOf(table) + 1] : tables[0]
    const index = next?.range[0] ?? result.length
    const prefix = table?.resolvedKey.length ?? 0
    const eol = result.includes('\r\n') ? '\r\n' : '\n'
    const entry = `${keys.slice(prefix).map(keyText).join('.')} = ${serialized}${eol}`
    const separator = index > 0 && result[index - 1] !== '\n' ? eol : ''
    result = result.slice(0, index) + separator + entry + result.slice(index)
  }
  readTomlConfig(result)
  return result
}
