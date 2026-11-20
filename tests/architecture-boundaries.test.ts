import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SRC_ROOT = join(REPO_ROOT, "src")

const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g

function collectTsFiles(dir: string): Array<string> {
  const results: Array<string> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath))
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      results.push(fullPath)
    }
  }
  return results
}

function toRepoRelative(filePath: string): string {
  return relative(REPO_ROOT, filePath).replaceAll("\\", "/")
}

function resolveInternalImport(
  fromFile: string,
  specifier: string,
  srcFiles: Set<string>,
): string | null {
  let candidateBase: string
  if (specifier.startsWith("~/")) {
    candidateBase = join(SRC_ROOT, specifier.slice(2))
  } else if (specifier.startsWith(".")) {
    candidateBase = resolve(dirname(fromFile), specifier)
  } else {
    return null
  }

  const candidates = [
    candidateBase,
    `${candidateBase}.ts`,
    `${candidateBase}.tsx`,
    join(candidateBase, "index.ts"),
    join(candidateBase, "index.tsx"),
  ]

  for (const candidate of candidates) {
    const rel = toRepoRelative(candidate)
    if (srcFiles.has(rel)) {
      return rel
    }
  }

  return null
}

function buildSourceImportGraph(): Map<string, Set<string>> {
  const absoluteFiles = collectTsFiles(SRC_ROOT)
  const fileSet = new Set(absoluteFiles.map(toRepoRelative))
  const graph = new Map<string, Set<string>>()

  for (const filePath of absoluteFiles) {
    const from = toRepoRelative(filePath)
    const content = readFileSync(filePath, "utf8")
    const deps = new Set<string>()
    for (const match of content.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      const resolved = resolveInternalImport(filePath, specifier, fileSet)
      if (resolved && resolved !== from) {
        deps.add(resolved)
      }
    }
    graph.set(from, deps)
  }

  return graph
}

function findStronglyConnectedComponents(
  graph: Map<string, Set<string>>,
): Array<Array<string>> {
  let index = 0
  const stack: Array<string> = []
  const onStack = new Set<string>()
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const components: Array<Array<string>> = []

  const visit = (node: string) => {
    indices.set(node, index)
    lowlink.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)

    for (const neighbor of graph.get(node) ?? []) {
      if (!indices.has(neighbor)) {
        visit(neighbor)
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(neighbor)!))
      } else if (onStack.has(neighbor)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(neighbor)!))
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: Array<string> = []
      while (stack.length > 0) {
        const current = stack.pop()!
        onStack.delete(current)
        component.push(current)
        if (current === node) break
      }
      if (component.length > 1) {
        components.push(component.sort())
      }
    }
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) {
      visit(node)
    }
  }

  return components
}

describe("architecture boundaries", () => {
  const graph = buildSourceImportGraph()

  test("src has no circular dependencies", () => {
    expect(findStronglyConnectedComponents(graph)).toEqual([])
  })

  test("src/lib/types only imports internal modules from src/lib/types", () => {
    const violations: Array<string> = []
    for (const [from, deps] of graph) {
      if (!from.startsWith("src/lib/types/")) continue
      for (const to of deps) {
        if (!to.startsWith("src/lib/types/")) {
          violations.push(`${from} -> ${to}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("src/lib never imports from src/routes", () => {
    const violations: Array<string> = []
    for (const [from, deps] of graph) {
      if (!from.startsWith("src/lib/")) continue
      for (const to of deps) {
        if (to.startsWith("src/routes/")) {
          violations.push(`${from} -> ${to}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
