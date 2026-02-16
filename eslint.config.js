import config from "@echristian/eslint-config"

export default config({
  ignores: [".claude/**", ".opencode/**"],
  prettier: {
    plugins: ["prettier-plugin-packagejson"],
  },
})
