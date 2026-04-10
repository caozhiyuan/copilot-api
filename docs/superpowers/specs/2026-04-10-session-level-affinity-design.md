# Session-Level Affinity & Stable Interaction ID

## Problem

When Codex connects to copilot-api via `/v1/responses`, the upstream Copilot API returns:

```
status_code=401, {"error":{"message":"input item does not belong to this connection","code":""}}
```

This occurs on every new user message in the same Codex session.

### Root Cause

Two issues in the `/v1/responses` handler:

1. **`x-interaction-id` changes per message** — `upstreamSessionId` is derived from `upstreamRequestId` which includes `lastUserContent`, making it different for every new message. The upstream Copilot API uses `x-interaction-id` to bind sessions; when it changes, the upstream rejects input that references previous responses.

2. **Affinity key is message-level, not session-level** — The affinity cache key includes `lastUserContent`, so the same session with a new message generates a different key and may route to a different account.

### Why Claude Code Is Unaffected

- Claude Code uses `/v1/messages` which passes `sessionId` from `getRootSessionId()` (stable per session) to `createResponses()`.
- The `/v1/messages` protocol is stateless (full history sent each time), so even without perfect affinity, the upstream doesn't reject requests.

## Design

### Change 1: Stable `upstreamSessionId` in `/v1/responses` handler

**File:** `src/routes/responses/handler.ts`

Before:
```ts
const upstreamSessionId = getUUID(upstreamRequestId) // changes per message
```

After:
```ts
const upstreamSessionId = normalizedPromptCacheKey
  ? getUUID(normalizedPromptCacheKey)
  : getUUID(upstreamRequestId)
```

When `prompt_cache_key` is present (Codex always sends it), the `x-interaction-id` header stays the same for the entire session.

### Change 2: Session-level affinity key in all handlers

Pass session-level identifiers to `selectAccountForRequest()` instead of per-message `upstreamRequestId`.

**`/v1/responses` handler:**
```ts
// Before
selectAccountForRequest(candidates, { requestId: upstreamRequestId })

// After
selectAccountForRequest(candidates, {
  requestId: normalizedPromptCacheKey ?? upstreamRequestId,
})
```

**`/v1/messages` handler:**
```ts
// Before
selectAccountForRequest(candidates, { requestId: upstreamRequestId })

// After
selectAccountForRequest(candidates, {
  requestId: sessionId ?? upstreamRequestId,
})
```

**`/v1/chat/completions` handler:**
```ts
// Before
selectAccountForRequest(candidates, { requestId: upstreamRequestId })

// After
selectAccountForRequest(candidates, {
  requestId: normalizedPromptCacheKey ?? upstreamRequestId,
})
```

### Change 3: Remove `macMachineId` from affinity key generation (already done)

`generateRequestIdFromPayload()` no longer includes `state.macMachineId` in the hash — it was a server-side constant with no distinguishing power.

## Files Changed

| File | Change |
|------|--------|
| `src/routes/responses/handler.ts` | Stable `upstreamSessionId` + session-level affinity |
| `src/routes/messages/handler.ts` | Session-level affinity |
| `src/routes/chat-completions/handler.ts` | Session-level affinity |
| `src/lib/utils.ts` | Remove `macMachineId` from hash (already done) |

## Risks

- **Affinity granularity** becomes coarser (session-level vs message-level). This is intentional — message-level affinity was only useful for retries, not for session routing.
- **Fallback behavior** when `prompt_cache_key` / `sessionId` is absent: falls back to `upstreamRequestId` (current behavior), so no regression for clients that don't provide session identifiers.
