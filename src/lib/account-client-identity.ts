import { createHash, randomUUID } from "node:crypto"

import { normalizeDomain } from "./api-config"

export const DEFAULT_IDENTITY_OAUTH_APP = "default"
export const DEFAULT_IDENTITY_ENTERPRISE_DOMAIN = "public"

export interface AccountIdentityEnvironment {
  oauthApp: string
  enterpriseDomain: string
}

export const getCurrentIdentityEnvironment = (): AccountIdentityEnvironment => {
  const rawOauthApp = process.env.COPILOT_API_OAUTH_APP?.trim().toLowerCase()
  const rawEnterpriseDomain = process.env.COPILOT_API_ENTERPRISE_URL?.trim()

  return {
    oauthApp: rawOauthApp || DEFAULT_IDENTITY_OAUTH_APP,
    enterpriseDomain:
      rawEnterpriseDomain ?
        normalizeDomain(rawEnterpriseDomain).toLowerCase()
      : DEFAULT_IDENTITY_ENTERPRISE_DOMAIN,
  }
}

export const buildIdentityKey = ({
  login,
  oauthApp,
  enterpriseDomain,
}: {
  login: string
  oauthApp: string
  enterpriseDomain: string
}): string => `${enterpriseDomain}:${oauthApp}:${login}`

export const createAccountDeviceId = (): string => randomUUID().toLowerCase()

export const createAccountMachineId = (): string =>
  createHash("sha256").update(randomUUID(), "utf8").digest("hex")

export const createAccountSessionId = (): string =>
  randomUUID() + Date.now().toString()
