import type { BuildOptions } from "esbuild"

import { build, context } from "esbuild"
import { rmSync } from "node:fs"
import path from "node:path"

type CliArgs = {
  debug: boolean
  watch: boolean
}

function parseArgs(argv: Array<string>): CliArgs {
  return {
    debug: argv.includes("--debug"),
    watch: argv.includes("--watch"),
  }
}

const args = parseArgs(process.argv.slice(2))

rmSync(path.join(process.cwd(), "dist"), { recursive: true, force: true })

const banner = [
  "import { createRequire as __createRequire } from 'node:module';",
  "const require = __createRequire(import.meta.url);",
].join("\n")

const options: BuildOptions = {
  entryPoints: ["src/extension.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node18"],
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  entryNames: "[name]",
  external: ["vscode", "electron"],
  banner: { js: banner },
  sourcemap: args.debug,
  sourcesContent: args.debug,
}

if (args.watch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await build(options)
}
