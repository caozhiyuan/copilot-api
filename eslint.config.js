import config from "@echristian/eslint-config"

export default config({
  ignores: ["vscode-extension/media/**"],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
