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
