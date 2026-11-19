export const COST_NANOS_PER_UNIT = 1_000_000_000

export function toCostNanos(amount: number): number {
  return Math.round(amount * COST_NANOS_PER_UNIT)
}

export function isValidCostAmount(amount: unknown): amount is number {
  return (
    typeof amount === "number"
    && amount >= 0
    && Number.isSafeInteger(toCostNanos(amount))
  )
}

// Shared with the OpenCode model catalog: 6.7 CNY per USD.
const CNY_PER_USD = 6.7

export function resolveUsdRate(currency: string | null): number | undefined {
  if (currency === "USD") return 1
  if (currency === "CNY") return 1 / CNY_PER_USD
  return undefined
}

export function toUsdCostNanos(
  currency: string,
  costNanos: number,
): number | null {
  const rate = resolveUsdRate(currency)
  return (
      rate !== undefined && Number.isSafeInteger(costNanos) && costNanos >= 0
    ) ?
      Math.round(costNanos * rate)
    : null
}
