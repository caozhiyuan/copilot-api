import config from "@echristian/eslint-config"

export default config({
  ignores: ["claude-plugin/**", ".opencode/**"],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
