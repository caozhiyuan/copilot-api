import type { useLanguage } from '../../contexts/LanguageContext'
import type {
  ProviderAuthTypeInput,
  ProviderType,
  QuickProviderName,
} from '../../types/ipc'

export type AuthTranslateFn = ReturnType<typeof useLanguage>['t']
export type ProviderChoice = QuickProviderName | 'custom'
export type OAuthProvider = 'codex' | 'xai'

export const PROVIDER_TYPES: ProviderType[] = [
  'anthropic',
  'openai-compatible',
  'openai-responses',
  'google',
]

export const PROVIDER_AUTH_TYPES: ProviderAuthTypeInput[] = [
  '__default__',
  'x-api-key',
  'x-goog-api-key',
  'authorization',
]

export const MAX_OAUTH_ACCOUNTS = 3

export const QUICK_PROVIDERS: QuickProviderName[] = [
  'opencode-go',
  'kimi',
  'deepseek',
  'dashscope',
  'openrouter',
]

export const PROVIDER_COLORS: Record<QuickProviderName, string> = {
  'opencode-go': 'bg-sky-500',
  kimi: 'bg-cyan-500',
  deepseek: 'bg-emerald-500',
  dashscope: 'bg-orange-500',
  openrouter: 'bg-violet-500',
}

// Renderer cannot import main-process config. Keep this in sync with src/lib/config/quick-providers.ts.
export const QUICK_PROVIDER_DEFAULTS: Record<
  QuickProviderName,
  { baseUrl: string; editableType: boolean; type: ProviderType }
> = {
  'opencode-go': {
    baseUrl: 'https://opencode.ai/zen/go',
    editableType: false,
    type: 'openai-compatible',
  },
  kimi: {
    baseUrl: 'https://api.kimi.com/coding',
    editableType: true,
    type: 'openai-compatible',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    editableType: true,
    type: 'anthropic',
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    editableType: true,
    type: 'openai-compatible',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api',
    editableType: false,
    type: 'anthropic',
  },
}

export function formatAccountId(accountId: string): string {
  return accountId.length > 18 ?
      `${accountId.slice(0, 9)}…${accountId.slice(-6)}`
    : accountId
}

export function getQuickProviderLabel(
  t: AuthTranslateFn,
  provider: QuickProviderName,
): string {
  switch (provider) {
    case 'opencode-go':
      return t('auth.providerOpencodeGo')
    case 'kimi':
      return t('auth.providerKimi')
    case 'deepseek':
      return t('auth.providerDeepseek')
    case 'dashscope':
      return t('auth.providerDashscope')
    case 'openrouter':
      return t('auth.providerOpenrouter')
  }
}
