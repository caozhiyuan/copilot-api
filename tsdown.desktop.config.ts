import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    main: "src/main.ts",
    "usage-worker": "src/lib/token-usage/worker.ts",
  },

  format: ["esm"],
  target: "es2022",
  platform: "node",

  sourcemap: true,
  clean: true,
  fixedExtension: false,
  nodeProtocol: false,

  deps: {
    alwaysBundle: () => true,
  },

  env: {
    NODE_ENV: "production",
  },
})
