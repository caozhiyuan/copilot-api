import { resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { findPackageJSON } from "node:module"
import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"
import ts from "typescript"

const root = dirname(fileURLToPath(import.meta.url))
const harness = process.env.HARNESS_SOURCE
if (!harness) throw new Error("Set HARNESS_SOURCE to a built, unmodified deepseek-harness checkout (see README.md)")
const source = resolve(harness)
const parsed = ts.readConfigFile(resolve(source, "tsconfig.base.json"), ts.sys.readFile)
if (parsed.error) throw new Error("Cannot read Harness TypeScript source aliases")
// Exact aliases also cover this external test directory, outside Harness's own
// tsconfig include scope. Every service uses the same source module singleton.
const aliases = Object.entries(parsed.config.compilerOptions.paths)
  .filter(([name]) => !name.includes("*"))
  .map(([name, paths]) => ({ find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u"), replacement: resolve(source, paths[0]) }))
const piManifestPath = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(resolve(source, "packages/llm/llm-pi-ai/package.json")))
const piRoot = dirname(piManifestPath)
const piManifest = JSON.parse(readFileSync(piManifestPath, "utf8"))
aliases.push({ find: /^@earendil-works\/pi-ai$/u, replacement: resolve(piRoot, piManifest.exports["."].import) })
aliases.push({ find: /^@earendil-works\/pi-ai\/api\/(.+)$/u, replacement: resolve(piRoot, piManifest.exports["./api/*"].import.replace("*", "$1")) })
const { standardDecoratorPlugin, vitestExecArgv } = await import(pathToFileURL(resolve(source, "vitest.shared.ts")).href)

export default defineConfig({
  root,
  plugins: [standardDecoratorPlugin()],
  resolve: { alias: [
    ...aliases,
    { find: "harness-test/catalog", replacement: resolve(source, "packages/api/session-controller/src/catalog.ts") },
    { find: "harness-test/profile-composition", replacement: resolve(source, "packages/settings/settings/tests/profile-composition.ts") },
  ] },
  test: {
    include: ["tests/*.test.ts"],
    exclude: ["tests/*.bun.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks", maxWorkers: 2, execArgv: vitestExecArgv,
    coverage: { provider: "v8", include: ["*.js"], exclude: ["vitest.config.js"], reporter: ["text"], thresholds: { lines: 80, functions: 80, statements: 80 } },
  },
})
