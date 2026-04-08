# Multi-Account Timing Stagger Design

**Date**: 2026-04-08  
**Status**: Draft  
**Scope**: Account initialization stagger + token refresh jitter

## Background

When copilot-api manages multiple GitHub Copilot accounts (~20) on a single machine with a single IP, the current implementation creates two timing-related risk patterns:

1. **Initialization burst**: All accounts initialize sequentially in a tight loop, generating `3N` upstream API calls (token + quota + models) within seconds.
2. **Token refresh synchronization**: All accounts receiving the same `refresh_in` value will refresh their tokens at nearly the same moment, creating periodic bursts.

These patterns may trigger upstream rate limiting or anomaly detection.

## Goals

- Spread account initialization over time to avoid startup burst traffic
- Add jitter to token refresh timing to prevent synchronized refresh storms
- Minimal code changes, no changes to core request flow or account selection logic
- Maintain all existing safety guarantees (pre-expiry refresh buffer, auth snapshot protection)

## Non-Goals

- IP diversification / proxy pool (separate future enhancement)
- Request header fingerprint diversification
- 429 retry with account switching
- Affinity hotspot protection
- Per-account rate limiting

## Design

### 1. Initialization Stagger

**File**: `src/lib/accounts-manager.ts`  
**Method**: `initialize()`

**Current behavior** (line 176-183):
```typescript
for (const account of this.accounts.values()) {
  try {
    await this.initializeAccount(account)
  } catch (error) {
    // ... error handling
  }
}
```

**Proposed behavior**:
```typescript
const INIT_STAGGER_MIN_MS = 2000
const INIT_STAGGER_MAX_MS = 5000

let isFirst = true
for (const account of this.accounts.values()) {
  if (!isFirst) {
    const delay = INIT_STAGGER_MIN_MS +
      Math.floor(Math.random() * (INIT_STAGGER_MAX_MS - INIT_STAGGER_MIN_MS))
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  isFirst = false

  try {
    await this.initializeAccount(account)
  } catch (error) {
    // ... error handling unchanged
  }
}
```

**Characteristics**:
- First account initializes immediately (fast startup for single-account usage)
- Subsequent accounts wait 2-5 seconds each (randomized)
- 20 accounts: total startup time ≈ 38-95 seconds
- Constants defined at module level for easy adjustment

### 2. Token Refresh Jitter

**File**: `src/lib/accounts-manager.ts`  
**Method**: `computeTokenRefreshDelayMs()`

**Current behavior** (line 205-207):
```typescript
private computeTokenRefreshDelayMs(refreshInSeconds: number): number {
  return Math.max((refreshInSeconds - 60) * 1000, 1000)
}
```

**Proposed behavior**:
```typescript
const TOKEN_REFRESH_JITTER_MS = 30_000

private computeTokenRefreshDelayMs(refreshInSeconds: number): number {
  const baseDelay = Math.max((refreshInSeconds - 60) * 1000, 1000)
  const jitter = Math.floor(Math.random() * TOKEN_REFRESH_JITTER_MS)
  // Ensure the jittered delay doesn't exceed the token's validity window
  const maxSafeDelay = Math.max(refreshInSeconds * 1000 - 1000, 1000)
  return Math.min(baseDelay + jitter, maxSafeDelay)
}
```

**Characteristics**:
- Adds 0-30 seconds of random jitter on top of the base delay
- Base delay already reserves a 60-second buffer before expiry
- Total delay is capped at `refreshInSeconds * 1000 - 1000` to guarantee refresh occurs at least 1 second before token expiry, even when `refresh_in` is unusually small
- 20 accounts spread across a 30-second window ≈ 1.5s average spacing
- Jitter is re-randomized on each refresh cycle (no persistent pattern)

### Session Refresh — No Changes

The existing session refresh already includes adequate jitter:
```typescript
const SESSION_REFRESH_BASE_MS = 60 * 60 * 1000     // 1 hour
const SESSION_REFRESH_JITTER_MS = 20 * 60 * 1000    // 0-20 minutes
```

No modification needed.

## New Constants Summary

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `INIT_STAGGER_MIN_MS` | `2000` | `accounts-manager.ts` | Minimum delay between account inits |
| `INIT_STAGGER_MAX_MS` | `5000` | `accounts-manager.ts` | Maximum delay between account inits |
| `TOKEN_REFRESH_JITTER_MS` | `30_000` | `accounts-manager.ts` | Random jitter window for token refresh |

## Files Changed

| File | Change |
|------|--------|
| `src/lib/accounts-manager.ts` | Add stagger delay in `initialize()` loop; add jitter in `computeTokenRefreshDelayMs()` |

## Testing

- Existing tests do not cover initialization timing or refresh scheduling — no breakage expected.
- Optional: add unit test for `computeTokenRefreshDelayMs()` to verify jitter range (base + [0, 30s]).
- Manual verification: observe startup logs to confirm staggered initialization timing.

## Future Enhancements (Out of Scope)

If needed later, these can be added incrementally:

1. **Per-account rate limiting** — independent request rate caps per account
2. **429 intelligent retry** — auto-switch account on rate limit, with backoff
3. **Request header diversification** — per-account `editor-version` variance
4. **Affinity hotspot protection** — flow caps on affinity-bound accounts
5. **Account health scoring** — priority routing based on error rate / quota remaining
6. **IP diversification** — proxy pool for per-account outbound IPs
