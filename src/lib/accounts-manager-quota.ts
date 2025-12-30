import type { AccountRuntime } from "~/lib/types/account"
import type { Model } from "~/services/copilot/get-models"

export const getCostUnits = (model: Model): number => {
  // Per user decision: missing billing => treat as free (costUnits = 0)
  const billing = model.billing
  if (!billing) {
    return 0
  }

  if (billing.is_premium !== true) {
    return 0
  }

  const multiplier = billing.multiplier
  if (
    typeof multiplier !== "number"
    || !Number.isFinite(multiplier)
    || multiplier <= 0
  ) {
    return 1
  }

  return multiplier
}

export const getEffectivePremiumRemaining = (
  account: AccountRuntime,
): number | undefined => {
  if (account.premiumRemaining === undefined) {
    return undefined
  }

  const reserved = account.premiumReserved ?? 0
  return account.premiumRemaining - reserved
}

export const reservePremiumUnits = (
  account: AccountRuntime,
  units: number,
): { id: symbol } | undefined => {
  if (units <= 0) {
    return undefined
  }

  const id = Symbol("quotaReservation")

  if (!account.premiumReservations) {
    account.premiumReservations = new Map()
  }

  account.premiumReservations.set(id, units)
  account.premiumReserved = (account.premiumReserved ?? 0) + units

  return { id }
}

export const releasePremiumReservation = (
  account: AccountRuntime,
  reservation?: { id: symbol },
): void => {
  if (!reservation) {
    return
  }

  const reservations = account.premiumReservations
  if (!reservations) {
    return
  }

  const reservedUnits = reservations.get(reservation.id)
  if (reservedUnits === undefined) {
    return
  }

  reservations.delete(reservation.id)

  const nextReserved = (account.premiumReserved ?? 0) - reservedUnits
  account.premiumReserved = Math.max(0, nextReserved)

  if (reservations.size === 0) {
    account.premiumReservations = undefined
  }
}
