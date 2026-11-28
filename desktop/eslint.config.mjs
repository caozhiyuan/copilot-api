import eslint from '@eslint/js'
import gitignore from 'eslint-config-flat-gitignore'
import prettier from 'eslint-plugin-prettier/recommended'
import reactHooks from 'eslint-plugin-react-hooks'
import unusedImports from 'eslint-plugin-unused-imports'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import tseslint from 'typescript-eslint'

const configDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'release/**',
      'dist/**',
      '*.tsbuildinfo',
      'electron.vite.config.*.mjs',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  gitignore(),
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'scripts/ensure-electron.mjs',
          ],
        },
        tsconfigRootDir: configDir,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'unused-imports': unusedImports,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: false },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
      'prettier/prettier': [
        'error',
        {
          experimentalOperatorPosition: 'start',
          experimentalTernaries: true,
          semi: false,
          singleQuote: true,
        },
      ],
      'unused-imports/no-unused-imports': 'error',
    },
  },
  {
    files: [
      'eslint.config.mjs',
      'scripts/ensure-electron.mjs',
      'desktop/eslint.config.mjs',
      'desktop/scripts/ensure-electron.mjs',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['tests/**/*', 'desktop/tests/**/*'],
    rules: {
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
)
