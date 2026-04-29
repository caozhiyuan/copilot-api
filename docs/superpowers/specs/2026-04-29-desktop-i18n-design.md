# Desktop i18n Design

## Summary

Add lightweight i18n support to the Electron desktop app. English default, Chinese supported, architecture allows future languages. System locale auto-detected on first launch; user can override in Settings; changes take effect immediately (hot-switch).

## Scope

- Languages: `en` (default) + `zh`, extensible
- Language preference stored in `DesktopSettings.language: 'en' | 'zh' | 'auto'`
- `'auto'` resolves via `navigator.language` at runtime
- Zero extra npm dependencies

## Files

| File | Action |
|---|---|
| `desktop/src/locales/index.ts` | NEW — `Locale` type, `Language`/`LangPreference` types, `locales` map |
| `desktop/src/locales/en.ts` | NEW — English strings |
| `desktop/src/locales/zh.ts` | NEW — Chinese strings |
| `desktop/src/contexts/LanguageContext.tsx` | NEW — Context, Provider, `useLanguage` hook |
| `desktop/src/main.tsx` | MODIFY — wrap `<App>` in `<LanguageProvider>` |
| `desktop/src/App.tsx` | MODIFY — call `setLanguage()` after settings load |
| `desktop/src/types/ipc.ts` | MODIFY — add `language` field to `DesktopSettings` |
| `desktop/electron/settings-store.ts` | MODIFY — add `language: 'auto'` to `DEFAULT_SETTINGS` |
| `desktop/src/components/SettingsModal.tsx` | MODIFY — language section + `t()` throughout |
| `desktop/src/components/Header.tsx` | MODIFY — `t()` throughout |
| `desktop/src/pages/AuthPage.tsx` | MODIFY — `t()` throughout |
| `desktop/src/pages/DashboardPage.tsx` | MODIFY — `t()` throughout |

## Key Design Decisions

### `t()` function signature

```typescript
t(key: LocaleKey, vars?: Record<string, string | number>): string
// LocaleKey is a dotted path type: 'auth.subtitle' | 'dashboard.port' | ...
// vars supports {{n}} interpolation for e.g. modelsCount
```

### Initialization

1. `LanguageProvider` auto-detects from `navigator.language` as initial state
2. `App.tsx` loads settings → if `language !== 'auto'`, calls `setLanguage()`
3. `SettingsModal` on save → calls `saveSettings()` + `setLanguage(resolved)`

### Language section in SettingsModal

Three radio-style options: Auto / English / 中文. Matches existing visual style (Row component).

### auth.ts reuse decision

`desktop/electron/auth.ts` stays independent. `src/auth.ts` is a CLI command wrapper with server-side deps and is not reusable in Electron context.
