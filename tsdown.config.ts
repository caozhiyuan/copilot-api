import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,
  // 将所有 npm 依赖打包进 dist，使输出可在无 node_modules 的环境（如桌面应用）独立运行
  // Node.js 内置模块（node:fs 等）由 rolldown 自动保持为 external，无需额外配置
  noExternal: () => true,

  env: {
    NODE_ENV: "production",
  },
})
