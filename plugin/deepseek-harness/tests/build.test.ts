import { readFile, stat } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const root = new URL("../", import.meta.url)

it("exports built JavaScript and declarations from both package entry points", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
  expect(manifest.main).toBe("dist/index.js")
  for (const key of [".", "./client"]) {
    const entry = manifest.exports[key]
    expect((await stat(new URL(entry.default, root))).isFile()).toBe(true)
    expect((await stat(new URL(entry.types, root))).isFile()).toBe(true)
  }
  for (const name of ["index", "config", "catalog", "models", "provider", "transport"]) {
    const compiled = await readFile(new URL(`dist/${name}.js`, root), "utf8")
    expect(compiled).not.toMatch(/from\s+["']\.[^"']+\.ts["']/u)
  }
})

it("loads the built Host plugin in plain Node without a TypeScript loader", () => {
  const entry = new URL("dist/index.js", root).href
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    const plugin = await import(${JSON.stringify(entry)})
    if (plugin.name !== "copilot-api-provider" || typeof plugin.apply !== "function") process.exit(1)
    if (plugin.Config({}).protocol !== "openai-responses") process.exit(2)
  `], { cwd: fileURLToPath(root), encoding: "utf8" })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
})
