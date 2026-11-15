import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
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

type Scalar = string | boolean
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
    const serialized = JSON.stringify(value)
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
