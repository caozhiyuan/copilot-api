import eslint from "@eslint/js"
import gitignore from "eslint-config-flat-gitignore"
import prettier from "eslint-plugin-prettier/recommended"
import unusedImports from "eslint-plugin-unused-imports"
import { defineConfig } from "eslint/config"
import globals from "globals"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import tseslint from "typescript-eslint"

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig(
  { ignores: ["plugin/**", "desktop/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  gitignore(),
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: configDir,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
        },
      ],
      "prettier/prettier": [
        "error",
        {
          experimentalOperatorPosition: "start",
          experimentalTernaries: true,
          plugins: ["prettier-plugin-packagejson"],
          semi: false,
        },
      ],
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    files: [".agents/skills/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
)
