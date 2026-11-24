export function isAntigravityUserAgent(userAgent: string | undefined): boolean {
  return /^antigravity\//iu.test(userAgent?.trim() ?? "")
}
