import type { Reasoning } from "~/lib/types/responses"

export type ResponsesReasoningEffort = Exclude<
  Reasoning["effort"],
  null | undefined
>

// Ascending reasoning intensity understood by upstream APIs.
const REASONING_EFFORT_LEVELS: Array<ResponsesReasoningEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const KNOWN_REASONING_EFFORTS: ReadonlySet<string> = new Set(
  REASONING_EFFORT_LEVELS,
)

// Client-facing levels that upstream APIs do not understand. Codex's "ultra"
// tier is an execution mode that combines max reasoning with multi-agent
// orchestration. The orchestration is client-side, so Codex sends "max" on the
// wire and never forwards "ultra" upstream. "minimal" pins to "low" only when
// the upstream capabilities show that "minimal" is unsupported.
const REASONING_EFFORT_ALIASES: Record<string, ResponsesReasoningEffort> = {
  minimal: "low",
  ultra: "max",
}

const reasoningEffortRank = (effort: ResponsesReasoningEffort): number =>
  REASONING_EFFORT_LEVELS.indexOf(effort)

/**
 * Resolves the reasoning effort to send upstream for a requested effort.
 *
 * Policy:
 * - A supported effort passes through unchanged.
 * - Client-only levels are aliased first ("ultra" -> "max").
 * - An unsupported request clamps to the highest supported level not above
 *   the request, e.g. "max" against ["low", "medium", "high", "xhigh"]
 *   resolves to "xhigh".
 * - A request below every supported level resolves to the lowest supported
 *   level, e.g. "none" against ["low", "medium", "high"] resolves to "low".
 * - Without any known supported levels, valid wire efforts pass through and
 *   client-facing aliases are converted (for example, "ultra" -> "max").
 * - An unrecognized request is left unresolved so the upstream can validate
 *   it instead of receiving a silently substituted effort.
 */
export const resolveSupportedReasoningEffort = (
  requestedEffort: string,
  supportedEfforts: Array<string> | undefined,
): ResponsesReasoningEffort | undefined => {
  const supported = (supportedEfforts ?? []).filter(
    (effort): effort is ResponsesReasoningEffort =>
      KNOWN_REASONING_EFFORTS.has(effort),
  )
  const requestedWireEffort =
    KNOWN_REASONING_EFFORTS.has(requestedEffort) ?
      (requestedEffort as ResponsesReasoningEffort)
    : undefined
  if (supported.length === 0) {
    return requestedWireEffort ?? REASONING_EFFORT_ALIASES[requestedEffort]
  }
  if (requestedWireEffort && supported.includes(requestedWireEffort)) {
    return requestedWireEffort
  }

  const aliasedEffort =
    REASONING_EFFORT_ALIASES[requestedEffort] ?? requestedWireEffort
  if (!aliasedEffort) {
    return undefined
  }
  if (supported.includes(aliasedEffort)) {
    return aliasedEffort
  }

  const requestedRank = reasoningEffortRank(aliasedEffort)
  let nearestBelow: ResponsesReasoningEffort | undefined
  for (const effort of supported) {
    if (
      reasoningEffortRank(effort) <= requestedRank
      && (nearestBelow === undefined
        || reasoningEffortRank(effort) > reasoningEffortRank(nearestBelow))
    ) {
      nearestBelow = effort
    }
  }
  if (nearestBelow) {
    return nearestBelow
  }

  return supported.reduce((lowest, effort) =>
    reasoningEffortRank(effort) < reasoningEffortRank(lowest) ? effort : lowest,
  )
}
