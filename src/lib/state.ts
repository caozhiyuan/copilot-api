import { randomUUID } from "node:crypto"

import type { ModelsResponse } from "~/services/copilot/get-models"

import type { AccountContext, AccountType } from "./types/account"

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: AccountType
  models?: ModelsResponse
  vsCodeVersion?: string

  macMachineId?: string
  vsCodeSessionId?: string
  vsCodeDeviceId: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
  verbose: boolean

  copilotApiUrl?: string
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  verbose: false,
  vsCodeDeviceId: randomUUID(),
}

/**
 * Create an AccountContext from the current global state.
 * This is a compatibility layer for transitioning to multi-account support.
 * @throws Error if githubToken is not set in state
 */
export function accountFromState(): AccountContext {
  if (!state.githubToken) {
    throw new Error("GitHub token not set in state")
  }
  return {
    githubToken: state.githubToken,
    copilotToken: state.copilotToken,
    ...(state.copilotApiUrl !== undefined ?
      { copilotApiUrl: state.copilotApiUrl }
    : {}),
    accountType: state.accountType,
    vsCodeVersion: state.vsCodeVersion,
  }
}
