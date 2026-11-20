import type { CodexAccountSummary } from '../../types/ipc'

import {
  formatAccountId,
  MAX_OAUTH_ACCOUNTS,
  type AuthTranslateFn,
  type OAuthProvider,
} from './auth-constants'

interface OAuthAccountsCardProps {
  accountProvider: OAuthProvider
  accounts: Array<CodexAccountSummary>
  alias: string
  loading: boolean
  notice: string
  onAliasChange: (value: string) => void
  onAddAccount: () => void
  onSwitchAccount: (accountId: string) => void
  onRemoveAccount: (accountId: string) => void
  onBack: () => void
  t: AuthTranslateFn
}

export function OAuthAccountsCard({
  accountProvider,
  accounts,
  alias,
  loading,
  notice,
  onAliasChange,
  onAddAccount,
  onSwitchAccount,
  onRemoveAccount,
  onBack,
  t,
}: OAuthAccountsCardProps) {
  return (
    <div className="w-full max-w-[440px] flex flex-col gap-3 rounded-xl border border-line-soft bg-surface p-4 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-semibold text-ink">
            {t(
              accountProvider === 'codex' ? 'auth.codexAccounts' : (
                'auth.xaiAccounts'
              ),
            )}
          </p>
          <p className="mt-1 text-[12px] text-ink-faint">
            {t('auth.codexAccountLimit')}
          </p>
        </div>
        <span className="rounded-full bg-sunken px-2 py-1 text-[11px] font-semibold text-ink-faint">
          {accounts.length}/{MAX_OAUTH_ACCOUNTS}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {accounts.length === 0 && (
          <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[13px] text-ink-faint">
            {t(
              accountProvider === 'codex' ?
                'auth.codexNoAccounts'
              : 'auth.xaiNoAccounts',
            )}
          </p>
        )}
        {accounts.map((account) => (
          <div
            key={account.accountId}
            className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-ink">
                  {account.alias ?? formatAccountId(account.accountId)}
                </span>
                {account.active && (
                  <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                    {t('auth.codexActiveAccount')}
                  </span>
                )}
              </div>
              {account.alias && (
                <p
                  className="mt-0.5 truncate font-mono text-[11px] text-ink-faint"
                  title={account.accountId}
                >
                  {formatAccountId(account.accountId)}
                </p>
              )}
            </div>
            {!account.active && (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => onSwitchAccount(account.accountId)}
                  disabled={loading}
                  className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-soft transition-colors hover:bg-sunken disabled:opacity-50"
                >
                  {t('auth.codexUseAccount')}
                </button>
                <button
                  onClick={() => onRemoveAccount(account.accountId)}
                  disabled={loading}
                  className="rounded-md border border-red-200 px-2 py-1.5 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:hover:bg-red-500/15"
                >
                  {t('auth.codexRemoveAccount')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-faint">
            {t('auth.codexAccountAlias')}
          </span>
          <input
            value={alias}
            onChange={(event) => onAliasChange(event.target.value)}
            placeholder={t('auth.codexAccountAliasPlaceholder')}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>
        <button
          onClick={onAddAccount}
          disabled={loading}
          className="w-full rounded-lg bg-accent-strong py-2.5 text-[13px] font-semibold text-white transition-all hover:bg-accent-strong/90 disabled:opacity-50"
        >
          {loading ? t('auth.verifying') : t('auth.codexAddAccount')}
        </button>
      </div>

      {notice && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {notice}
        </p>
      )}

      <button
        onClick={onBack}
        className="text-center text-[13px] text-ink-faint hover:text-ink-soft"
      >
        {t('auth.back')}
      </button>
    </div>
  )
}
