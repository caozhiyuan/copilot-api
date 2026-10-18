import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const tsc = require.resolve("typescript/bin/tsc")
for (const args of [
  ["--project", "tsconfig.json"],
  ["--project", "tsconfig.client.json", "--noEmit", "false", "--emitDeclarationOnly"],
]) {
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: root, stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// Harness loads browser code as a lazy CommonJS factory. React remains the
// host's shared dependency; no SDK or Host code enters this browser bundle.
await build({
  absWorkingDir: root,
  entryPoints: ["src/client/index.ts"],
  outfile: "dist/client.js",
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["react"],
  sourcemap: true,
  banner: { js: 'window.__ModuleLoader__.load({ id: "copilot-api-provider", factory: (require) => { "use strict"; const module = { exports: {} }; const exports = module.exports;' },
  footer: { js: "return module.exports; } });" },
})
