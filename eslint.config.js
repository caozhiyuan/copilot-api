import config from "@echristian/eslint-config"

export default config({
  ignores: ["claude-plugin/**", ".opencode/**", "desktop/**"],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
