# Account Enable/Disable Toggle

**Date:** 2026-04-10  
**Status:** Draft  
**Scope:** Per-account enable/disable switch in Admin UI + backend support

## Problem

Currently, the only way to stop an account from being used for request routing is to delete it entirely. This is destructive — the user loses the account's auth tokens and must re-authenticate to add it back. A reversible enable/disable toggle is needed so operators can temporarily take an account out of rotation without losing its configuration.

## Decision Summary

- **Approach:** Registry-persisted `enabled` field on `AccountMeta`
- **Disabled behavior:** Completely excluded from request routing (no fallback)
- **Timing:** Immediate effect on toggle; in-flight requests are allowed to complete
- **All disabled:** Allowed; API returns 503 when no enabled accounts are available
- **UI placement:** Enabled column before Actions column in the account table

## Data Model

### `AccountMeta` (src/lib/types/account.ts)

Add an optional `enabled` field:

```typescript
export interface AccountMeta {
  id: string
  accountType: AccountType
  addedAt: number
  enabled?: boolean  // undefined and true are equivalent (backward compatible)
}
```

### Backward Compatibility

- Existing `registry.json` entries without `enabled` are treated as enabled.
- No data migration required.
- Registry version remains `2` (non-breaking additive change).

### Helper Function (src/lib/accounts-registry.ts)

```typescript
export function isAccountEnabled(meta: AccountMeta): boolean {
  return meta.enabled !== false
}
```

All enable/disable checks go through this function to avoid scattered `!== false` checks.

## Backend API

### New Endpoint

```
PATCH /api/admin/accounts/:id
Content-Type: application/json

Request:  { "enabled": boolean }
Response: { "success": true }
```

**Route location:** `src/routes/admin-api/route.ts`

**Logic:**
1. Validate `:id` exists in registry → 404 if not found
2. Validate request body contains `enabled` as boolean → 400 if invalid
3. Update the account's `enabled` field in the registry
4. Call `saveRegistry()` to persist
5. Call `accountsManager.reloadRegistryNow()` to hot-reload runtime state
6. Return `{ success: true }`

### Error Responses

| Status | Condition |
|--------|-----------|
| 400 | Missing or invalid `enabled` field in body |
| 404 | Account ID not found in registry |

## Account Selection Logic

### Changes to `selectAccountForRequest()` (src/lib/accounts-manager.ts)

Filter disabled accounts at the earliest stage of candidate construction:

1. Build the initial candidate list from all known accounts
2. **Filter out accounts where `isAccountEnabled()` returns false** ← new step
3. Continue with existing affinity / round-robin / quota logic

If the filtered candidate list is empty, the selection fails with an appropriate error, which the request handler translates to HTTP 503.

### Runtime State Sync

- `AccountRuntime` extends `AccountMeta`, so the `enabled` field is automatically available at runtime.
- `getAccountStatus()` already exposes the full runtime state to the admin API; the `enabled` field flows through without extra mapping.
- `reloadRegistryNow()` handles the hot-reload path: toggling the switch triggers save → reload → immediate effect.

## Admin UI Changes

### Account Table Column Order

```
Account | Status | Type | Premium | Requests | Errors | Tokens | Avg Ms | Last request | Enabled | Actions
```

The **Enabled** column is placed immediately before the **Actions** column.

### Switch Component

- Use shadcn/ui `Switch` component (already in the project's dependency tree).
- **Enabled state:** Switch is on; row renders with normal text styling.
- **Disabled state:** Switch is off; row text uses `text-muted-foreground` for reduced visual prominence.
- No secondary confirmation dialog — the operation is instantly reversible.

### Interaction Flow

1. User toggles Switch → optimistic local state update → call `PATCH /api/admin/accounts/:id`
2. On success: state confirmed, no further action
3. On failure: revert Switch to previous state, display toast error message

### Existing Actions

- **Reauth** and **Delete** remain available for disabled accounts.
- Disabling an account does not affect its token validity or registry presence.

## Files Changed

| File | Change |
|------|--------|
| `src/lib/types/account.ts` | Add `enabled?: boolean` to `AccountMeta` |
| `src/lib/accounts-registry.ts` | Add `isAccountEnabled()` helper |
| `src/lib/accounts-manager.ts` | Filter disabled accounts in `selectAccountForRequest()` |
| `src/routes/admin-api/route.ts` | Add `PATCH /api/admin/accounts/:id` endpoint |
| `admin-ui/src/pages/accounts-page.tsx` | Add Enabled column with Switch |
| `admin-ui/src/lib/admin-api.ts` | Add `patchAccount()` API client function |

## Testing

- Unit test: `isAccountEnabled()` with `true`, `false`, `undefined` inputs
- Unit test: `selectAccountForRequest()` skips disabled accounts
- Unit test: `selectAccountForRequest()` returns error when all candidates are disabled
- Integration test: `PATCH /api/admin/accounts/:id` happy path and error cases
- Manual: toggle switch in Admin UI, verify account stops receiving requests
