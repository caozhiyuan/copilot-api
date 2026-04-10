import type { AccountType, AuthStartRequest } from "./admin-api"

export function cleanEnterpriseDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
}

export function buildAccountAuthRequest({
  accountType,
  enterpriseDomain,
}: {
  accountType: AccountType
  enterpriseDomain: string
}): AuthStartRequest {
  const domain = cleanEnterpriseDomain(enterpriseDomain)

  return {
    accountType,
    enterpriseDomain:
      accountType === "enterprise" && domain ? domain : undefined,
  }
}
