#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import {
  addAccountToRegistry,
  listAccountsFromRegistry,
  loadAccountToken,
  removeAccountFromRegistry,
  removeAccountToken,
  saveAccountToken,
} from "./lib/accounts-registry"
import { ensurePaths } from "./lib/paths"
import { state } from "./lib/state"
import {
  parseAccountType,
  type AccountMeta,
  type AccountType,
} from "./lib/types/account"
import { getCopilotUsage } from "./services/github/get-copilot-usage"
import { getDeviceCode } from "./services/github/get-device-code"
import { getGitHubUser } from "./services/github/get-user"
import { pollAccessToken } from "./services/github/poll-access-token"

/**
 * Fetch quota info for an account (used by auth ls -q)
 */
async function fetchQuotaInfo(account: AccountMeta): Promise<string> {
  try {
    const token = await loadAccountToken(account.id)
    if (!token) {
      return " | Quota: (no token)"
    }

    const usage = await getCopilotUsage({
      githubToken: token,
      accountType: account.accountType,
    })
    const premium = usage.quota_snapshots.premium_interactions

    return premium.unlimited ?
        " | Quota: unlimited"
      : ` | Quota: ${premium.remaining}/${premium.entitlement}`
  } catch (error) {
    consola.debug(`Failed to fetch quota for ${account.id}:`, error)
    return " | Quota: (failed to fetch)"
  }
}

/**
 * auth add - Add a new GitHub Copilot account
 */
const authAdd = defineCommand({
  meta: {
    name: "add",
    description: "Add a new GitHub Copilot account",
  },
  args: {
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type (individual, business, enterprise)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token after auth",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
      consola.info("Verbose logging enabled")
    }

    state.showToken = args["show-token"]

    let accountType: AccountType
    try {
      accountType = parseAccountType(args["account-type"])
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }

    await ensurePaths()

    // Start device code flow
    consola.info("Starting GitHub device code authentication...")
    const deviceResponse = await getDeviceCode()
    consola.debug("Device code response:", deviceResponse)

    consola.info(
      `Please enter the code "${deviceResponse.user_code}" at ${deviceResponse.verification_uri}`,
    )

    // Poll for access token
    const token = await pollAccessToken(deviceResponse)

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }

    // Get user info to determine account ID
    const user = await getGitHubUser({ githubToken: token, accountType })
    const accountId = user.login

    // Save token and check if account already exists
    await saveAccountToken(accountId, token)
    const existingAccounts = await listAccountsFromRegistry()

    if (existingAccounts.some((acc) => acc.id === accountId)) {
      consola.success(
        `Account "${accountId}" already exists. Token has been updated.`,
      )
    } else {
      await addAccountToRegistry({
        id: accountId,
        accountType,
        addedAt: Date.now(),
      })
      consola.success(`Account "${accountId}" added successfully!`)
    }

    consola.info(`Account type: ${accountType}`)
  },
})

/**
 * auth ls - List all registered accounts
 */
const authLs = defineCommand({
  meta: {
    name: "ls",
    description: "List all registered accounts",
  },
  args: {
    "show-quota": {
      alias: "q",
      type: "boolean",
      default: false,
      description: "Show quota information (requires API call)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
    }

    await ensurePaths()

    const accounts = await listAccountsFromRegistry()

    if (accounts.length === 0) {
      consola.info("No accounts registered. Use 'auth add' to add an account.")
      return
    }

    consola.info(`Found ${accounts.length} account(s):\n`)

    for (const [i, account] of accounts.entries()) {
      const addedDate = new Date(account.addedAt).toLocaleString()

      const quotaInfo = args["show-quota"] ? await fetchQuotaInfo(account) : ""

      console.log(
        `  ${i + 1}. ${account.id} (${account.accountType})${quotaInfo}`,
      )
      console.log(`     Added: ${addedDate}\n`)
    }
  },
})

/**
 * auth rm - Remove an account
 */
const authRm = defineCommand({
  meta: {
    name: "rm",
    description: "Remove an account",
  },
  args: {
    target: {
      type: "positional",
      description: "Account ID or index (1-based)",
      required: true,
    },
    force: {
      alias: "f",
      type: "boolean",
      default: false,
      description: "Skip confirmation prompt",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
  },
  async run({ args }) {
    if (args.verbose) {
      consola.level = 5
    }

    await ensurePaths()

    const target = args.target
    const accounts = await listAccountsFromRegistry()

    if (accounts.length === 0) {
      consola.error("No accounts to remove.")
      return
    }

    // Determine account to remove (by ID or index)
    let accountToRemove: { id: string; index: number } | undefined

    // Try parsing as index (1-based)
    const index = Number.parseInt(target, 10)
    if (!Number.isNaN(index) && index >= 1 && index <= accounts.length) {
      accountToRemove = { id: accounts[index - 1].id, index: index - 1 }
    } else {
      // Try finding by ID
      const foundIndex = accounts.findIndex((acc) => acc.id === target)
      if (foundIndex !== -1) {
        accountToRemove = { id: accounts[foundIndex].id, index: foundIndex }
      }
    }

    if (!accountToRemove) {
      consola.error(`Account "${target}" not found.`)
      consola.info("Use 'auth ls' to see available accounts.")
      return
    }

    // Confirmation
    if (!args.force) {
      const confirmed = await consola.prompt(
        `Are you sure you want to remove account "${accountToRemove.id}"?`,
        { type: "confirm" },
      )
      if (!confirmed) {
        consola.info("Cancelled.")
        return
      }
    }

    // Remove token file and registry entry
    await removeAccountToken(accountToRemove.id)
    await removeAccountFromRegistry(accountToRemove.id)

    consola.success(`Account "${accountToRemove.id}" removed.`)
  },
})

/**
 * Main auth command with subcommands
 */
export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Manage GitHub Copilot accounts",
  },
  subCommands: {
    add: authAdd,
    ls: authLs,
    rm: authRm,
  },
  args: {
    // Legacy args for backward compatibility (when no subcommand)
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type (individual, business, enterprise)",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token after auth",
    },
  },
  async run(ctx) {
    // Check if a subcommand was specified in rawArgs.
    // Only treat the *first* raw arg as a subcommand to avoid false positives
    // when flags accept values like "add"/"ls"/"rm".
    const firstArg = ctx.rawArgs[0]
    const hasSubCommand =
      firstArg === "add" || firstArg === "ls" || firstArg === "rm"

    // Backward compatibility: if no subcommand, run 'add'
    if (!hasSubCommand && authAdd.run) {
      await authAdd.run(ctx)
    }
  },
})
