import { readEditableConfigFromDisk } from "~/lib/config"
import {
  createOAuthCredentialStore,
  withCredentialFileLock,
} from "~/lib/auth/credential-store"
import type { OAuthAccountSummary, OAuthCredentials } from "~/lib/types/oauth"

export function createOAuthAccountManager(options: {
  provider: string
  label: string
  credentialPath: () => string
  selectAccount: (accountId: string) => void
}) {
  const store = createOAuthCredentialStore(
    options.label,
    options.credentialPath,
  )
  const withMutationLock = <T>(operation: () => Promise<T>) =>
    withCredentialFileLock(`${options.credentialPath()}.accounts`, operation)
  const activeId = (accounts: Array<Pick<OAuthCredentials, "accountId">>) =>
    readEditableConfigFromDisk().providers?.[
      options.provider
    ]?.accountId?.trim()
    || (accounts.length === 1 ? accounts[0].accountId : undefined)
  const summarize = (
    account: { accountId: string; alias?: string },
    active: boolean,
  ): OAuthAccountSummary => ({
    accountId: account.accountId,
    ...(account.alias ? { alias: account.alias } : {}),
    active,
  })

  async function findAccount(selector: string) {
    const normalized = selector.trim()
    if (!normalized)
      throw new Error(
        `${options.label} account selector must be a non-empty string`,
      )
    const accounts = (await store.readStore())?.accounts ?? []
    const account =
      accounts.find((candidate) => candidate.accountId === normalized)
      ?? accounts.find(
        (candidate) =>
          candidate.alias?.toLowerCase() === normalized.toLowerCase(),
      )
    if (!account)
      throw new Error(`${options.label} account '${normalized}' was not found`)
    return { account, accounts }
  }

  return {
    store,
    withMutationLock,
    list: () =>
      withMutationLock(async () => {
        const accounts = (await store.readStore())?.accounts ?? []
        const active = activeId(accounts)
        return accounts.map((account) =>
          summarize(account, account.accountId === active),
        )
      }),
    select: (selector: string) =>
      withMutationLock(async () => {
        const { account } = await findAccount(selector)
        options.selectAccount(account.accountId)
        return summarize(account, true)
      }),
    remove: (selector: string) =>
      withMutationLock(async () => {
        const { account, accounts } = await findAccount(selector)
        if (account.accountId === activeId(accounts))
          throw new Error(
            `${options.label} account '${account.accountId}' is currently in use; switch to another account before removing it`,
          )
        const removed = await store.removeCredentials(account.accountId)
        return summarize(removed, false)
      }),
  }
}
