import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

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
