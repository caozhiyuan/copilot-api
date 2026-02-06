import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"

import {
  AdminApiError,
  type AdminConfig,
  type AdminConfigResponse,
  type ModelAliasSpec,
  type ReasoningEffort,
  getAdminConfig,
  getAdminModels,
  updateAdminConfig,
} from "@/lib/admin-api"
import { i18n } from "@/lib/i18n"
import { Button } from "@/components/ui/button"
import {
  FloatingSaveButton,
  SettingsNavigation,
  SettingsSectionCard,
} from "@/components/settings"
import { useActiveSection, type SettingsSection } from "@/hooks/use-active-section"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

const SETTINGS_SECTION_IDS = [
  "general",
  "reasoning",
  "aliases",
  "prompts",
  "advanced",
] as const

const REASONING_EFFORTS: Array<ReasoningEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]

type ExtraPromptItem = {
  id: string
  model: string
  prompt: string
}

type ReasoningItem = {
  id: string
  model: string
  effort: ReasoningEffort
}

type ModelAliasItem = {
  id: string
  alias: string
  target: string
  allowOriginal?: boolean
}

type ModelAliasRecord = Record<string, ModelAliasSpec>

type ModelAliasRecordInput = Record<string, ModelAliasSpec | string>

type ParseResult<T> = { record: T } | { error: string }

type JsonMode = "form" | "json"

type ToggleJsonModeOptions<TRecord> = {
  next: boolean
  record: TRecord | undefined
  setJson: (value: string) => void
  setError: (value: string | null) => void
  setMode: (mode: JsonMode) => void
}

type UpdateJsonRecordOptions<TRecord> = {
  value: string
  parse: (value: string) => ParseResult<TRecord>
  setJson: (value: string) => void
  setError: (value: string | null) => void
  onRecord: (record: TRecord) => void
}

function toggleJsonMode<TRecord>({
  next,
  record,
  setJson,
  setError,
  setMode,
}: ToggleJsonModeOptions<TRecord>): void {
  if (next) {
    setJson(JSON.stringify(record ?? {}, null, 2))
  }
  setError(null)
  setMode(next ? "json" : "form")
}

function updateJsonRecord<TRecord>({
  value,
  parse,
  setJson,
  setError,
  onRecord,
}: UpdateJsonRecordOptions<TRecord>): void {
  setJson(value)
  const result = parse(value)
  if ("error" in result) {
    setError(result.error)
    return
  }
  setError(null)
  onRecord(result.record)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createItemId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function extraPromptItemsFromRecord(
  record: Record<string, string> | undefined
): Array<ExtraPromptItem> {
  if (!record) return []
  return Object.entries(record).map(([model, prompt]) => ({
    id: createItemId(),
    model,
    prompt,
  }))
}

function reasoningItemsFromRecord(
  record: Record<string, ReasoningEffort> | undefined
): Array<ReasoningItem> {
  if (!record) return []
  return Object.entries(record).map(([model, effort]) => ({
    id: createItemId(),
    model,
    effort,
  }))
}

function aliasItemsFromRecord(
  record: ModelAliasRecordInput | undefined
): Array<ModelAliasItem> {
  if (!record) return []
  return Object.entries(record).map(([alias, spec]) => {
    if (typeof spec === "string") {
      return {
        id: createItemId(),
        alias,
        target: spec,
        allowOriginal: undefined,
      }
    }
    return {
      id: createItemId(),
      alias,
      target: spec.target,
      allowOriginal: spec.allowOriginal,
    }
  })
}

function extraPromptRecordFromItems(
  items: Array<ExtraPromptItem>
): Record<string, string> {
  const record: Record<string, string> = {}
  for (const item of items) {
    const key = item.model.trim()
    if (!key) continue
    record[key] = item.prompt
  }
  return record
}

function reasoningRecordFromItems(
  items: Array<ReasoningItem>
): Record<string, ReasoningEffort> {
  const record: Record<string, ReasoningEffort> = {}
  for (const item of items) {
    const key = item.model.trim()
    if (!key) continue
    record[key] = item.effort
  }
  return record
}

const BLOCKED_ALIAS_KEYS = new Set(["__proto__", "constructor", "prototype"])

function aliasRecordFromItems(items: Array<ModelAliasItem>): ModelAliasRecord {
  const record: ModelAliasRecord = Object.create(null) as ModelAliasRecord
  const seen = new Set<string>()

  for (const item of items) {
    const alias = item.alias.trim()
    const target = item.target.trim()
    if (!alias || !target) continue

    const normalizedAlias = alias.toLowerCase()
    if (BLOCKED_ALIAS_KEYS.has(normalizedAlias)) continue
    if (normalizedAlias === target.toLowerCase()) continue
    if (seen.has(normalizedAlias)) continue

    seen.add(normalizedAlias)
    record[alias] =
      item.allowOriginal === undefined
        ? { target }
        : { target, allowOriginal: item.allowOriginal }
  }

  return record
}

function parseExtraPromptsJson(
  value: string,
): ParseResult<Record<string, string>> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { error: "extraPrompts JSON must be an object of string values." }
    }

    const record: Record<string, string> = {}
    for (const [key, prompt] of Object.entries(parsed)) {
      if (typeof prompt !== "string") {
        return { error: `extraPrompts.${key} must be a string.` }
      }
      record[key] = prompt
    }

    return { record }
  } catch {
    return { error: "extraPrompts JSON is not valid." }
  }
}

function parseReasoningJson(
  value: string,
): ParseResult<Record<string, ReasoningEffort>> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { error: "modelReasoningEfforts JSON must be an object." }
    }

    const record: Record<string, ReasoningEffort> = {}
    for (const [key, effort] of Object.entries(parsed)) {
      if (typeof effort !== "string") {
        return { error: `modelReasoningEfforts.${key} must be a string.` }
      }
      if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
        return {
          error: `modelReasoningEfforts.${key} must be one of ${REASONING_EFFORTS.join(", ")}.`,
        }
      }
      record[key] = effort as ReasoningEffort
    }

    return { record }
  } catch {
    return { error: "modelReasoningEfforts JSON is not valid." }
  }
}

function parseModelAliasesJson(
  value: string,
): ParseResult<ModelAliasRecord> {
  if (!value.trim()) return { record: {} }

  try {
    const parsed = JSON.parse(value) as unknown
    if (!isPlainObject(parsed)) {
      return { error: "modelAliases JSON must be an object." }
    }

    const record: ModelAliasRecord = Object.create(null) as ModelAliasRecord
    const seen = new Set<string>()

    for (const [rawAlias, rawTarget] of Object.entries(parsed)) {
      const alias = rawAlias.trim()
      if (!alias) {
        return { error: "modelAliases keys must be non-empty strings." }
      }

      const normalizedAlias = alias.toLowerCase()
      if (BLOCKED_ALIAS_KEYS.has(normalizedAlias)) {
        return { error: `modelAliases.${rawAlias} is not allowed.` }
      }

      let target: string | undefined
      let allowOriginal: boolean | undefined

      if (typeof rawTarget === "string") {
        target = rawTarget.trim()
      } else if (isPlainObject(rawTarget)) {
        const rawTargetValue = rawTarget.target
        if (typeof rawTargetValue !== "string") {
          return { error: `modelAliases.${rawAlias}.target must be a string.` }
        }
        target = rawTargetValue.trim()

        if ("allowOriginal" in rawTarget) {
          if (typeof rawTarget.allowOriginal !== "boolean") {
            return {
              error: `modelAliases.${rawAlias}.allowOriginal must be a boolean.`,
            }
          }
          allowOriginal = rawTarget.allowOriginal
        }
      } else {
        return { error: `modelAliases.${rawAlias} must be a string or object.` }
      }

      if (!target) {
        return { error: `modelAliases.${rawAlias} must be a non-empty string.` }
      }

      if (normalizedAlias === target.toLowerCase()) {
        return { error: `modelAliases.${rawAlias} cannot map to itself.` }
      }
      if (seen.has(normalizedAlias)) {
        return { error: `modelAliases.${rawAlias} conflicts with another alias.` }
      }

      seen.add(normalizedAlias)
      record[alias] =
        allowOriginal === undefined ? { target } : { target, allowOriginal }
    }

    return { record }
  } catch {
    return { error: "modelAliases JSON is not valid." }
  }
}

type ExtraPromptEditor = {
  mode: JsonMode
  items: Array<ExtraPromptItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ExtraPromptItem>) => void
  setFromRecord: (record?: Record<string, string>) => void
}

type ReasoningEditor = {
  mode: JsonMode
  items: Array<ReasoningItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ReasoningItem>) => void
  setFromRecord: (record?: Record<string, ReasoningEffort>) => void
}

type ModelAliasEditor = {
  mode: JsonMode
  items: Array<ModelAliasItem>
  json: string
  jsonIssue: string | null
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
  setFromRecord: (record?: ModelAliasRecordInput) => void
}

function useExtraPromptEditor(
  onRecordChange: (record: Record<string, string>) => void,
): ExtraPromptEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<ExtraPromptItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () => (jsonError ? `extraPrompts: ${jsonError}` : null),
    [jsonError],
  )

  const setFromRecord = useCallback((record?: Record<string, string>) => {
    setItems(extraPromptItemsFromRecord(record))
    setJson(JSON.stringify(record ?? {}, null, 2))
    setJsonError(null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ExtraPromptItem>) => {
      setItems(nextItems)
      onRecordChange(extraPromptRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseExtraPromptsJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) => updateItems(extraPromptItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: extraPromptRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(items.concat({ id: createItemId(), model: "", prompt: "" }))
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<ExtraPromptItem>) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

function useReasoningEditor(
  onRecordChange: (record: Record<string, ReasoningEffort>) => void,
): ReasoningEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<ReasoningItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () => (jsonError ? `modelReasoningEfforts: ${jsonError}` : null),
    [jsonError],
  )

  const setFromRecord = useCallback((record?: Record<string, ReasoningEffort>) => {
    setItems(reasoningItemsFromRecord(record))
    setJson(JSON.stringify(record ?? {}, null, 2))
    setJsonError(null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ReasoningItem>) => {
      setItems(nextItems)
      onRecordChange(reasoningRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseReasoningJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) => updateItems(reasoningItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: reasoningRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(items.concat({ id: createItemId(), model: "", effort: "high" }))
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<ReasoningItem>) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

function useModelAliasEditor(
  onRecordChange: (record: ModelAliasRecord) => void,
): ModelAliasEditor {
  const [mode, setMode] = useState<JsonMode>("form")
  const [items, setItems] = useState<Array<ModelAliasItem>>([])
  const [json, setJson] = useState("")
  const [jsonError, setJsonError] = useState<string | null>(null)

  const jsonIssue = useMemo(
    () => (jsonError ? `modelAliases: ${jsonError}` : null),
    [jsonError],
  )

  const setFromRecord = useCallback((record?: ModelAliasRecordInput) => {
    const nextItems = aliasItemsFromRecord(record)
    const normalizedRecord = aliasRecordFromItems(nextItems)
    setItems(nextItems)
    setJson(JSON.stringify(normalizedRecord, null, 2))
    setJsonError(null)
  }, [])

  const updateItems = useCallback(
    (nextItems: Array<ModelAliasItem>) => {
      setItems(nextItems)
      onRecordChange(aliasRecordFromItems(nextItems))
    },
    [onRecordChange],
  )

  const onJsonChange = useCallback(
    (value: string) => {
      updateJsonRecord({
        value,
        parse: parseModelAliasesJson,
        setJson,
        setError: setJsonError,
        onRecord: (record) => updateItems(aliasItemsFromRecord(record)),
      })
    },
    [updateItems],
  )

  const onToggleMode = useCallback(
    (next: boolean) => {
      toggleJsonMode({
        next,
        record: aliasRecordFromItems(items),
        setJson,
        setError: setJsonError,
        setMode,
      })
    },
    [items],
  )

  const onAddItem = useCallback(() => {
    updateItems(
      items.concat({ id: createItemId(), alias: "", target: "", allowOriginal: undefined }),
    )
  }, [items, updateItems])

  const onRemoveItem = useCallback(
    (id: string) => {
      updateItems(items.filter((item) => item.id !== id))
    },
    [items, updateItems],
  )

  const onUpdateItem = useCallback(
    (id: string, patch: Partial<ModelAliasItem>) => {
      const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
      updateItems(next)
    },
    [items, updateItems],
  )

  return {
    mode,
    items,
    json,
    jsonIssue,
    onToggleMode,
    onJsonChange,
    onAddItem,
    onRemoveItem,
    onUpdateItem,
    setFromRecord,
  }
}

type GeneralSettingsCardProps = {
  hasModels: boolean
  smallModelLabel: string
  smallModelValue: string
  smallModelInputValue: string
  models: Array<string>
  apiKeyValue: string
  envOverrideNote: string
  onSmallModelSelect: (value: string) => void
  onSmallModelInput: (value: string) => void
  onApiKeyChange: (value: string) => void
}

function GeneralSettingsCard({
  hasModels,
  smallModelLabel,
  smallModelValue,
  smallModelInputValue,
  models,
  apiKeyValue,
  envOverrideNote,
  onSmallModelSelect,
  onSmallModelInput,
  onApiKeyChange,
}: GeneralSettingsCardProps): React.JSX.Element {
  const { t } = useTranslation()

  const showCustomModel =
    hasModels
    && smallModelValue !== "__default__"
    && !models.includes(smallModelValue)

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.general.title")}</CardTitle>
        <CardDescription className="hidden sm:block">{t("settingsPage.general.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">{smallModelLabel}</Label>
          {hasModels ? (
            <Select value={smallModelValue} onValueChange={onSmallModelSelect}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("settingsPage.general.smallModelPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t("settingsPage.common.defaultOption")}</SelectItem>
                {showCustomModel ? (
                  <SelectItem value={smallModelValue}>
                    {t("settingsPage.common.customModel", { value: smallModelValue })}
                  </SelectItem>
                ) : null}
                {models.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder={t("settingsPage.general.smallModelInputPlaceholder")}
              value={smallModelInputValue}
              onChange={(e) => onSmallModelInput(e.target.value)}
            />
          )}
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.general.smallModelHint")}
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">{t("settingsPage.general.apiKeyLabel")}</Label>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder={t("settingsPage.general.apiKeyPlaceholder")}
            value={apiKeyValue}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          <div className="text-muted-foreground text-xs">
            {envOverrideNote} {t("settingsPage.general.leaveEmptyHint")}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

type ReasoningEffortsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<ReasoningItem>
  models: Array<string>
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ReasoningItem>) => void
}

function ReasoningEffortsCard({
  mode,
  json,
  jsonIssue,
  items,
  models,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ReasoningEffortsCardProps): React.JSX.Element {
  const defaultModelValue = "__default__"
  const hasModels = models.length > 0
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.reasoning.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.reasoning.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.reasoning.hint")}
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">{t("settingsPage.common.jsonMode")}</Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
              placeholder={t("settingsPage.reasoning.jsonPlaceholder")}
            />
            {jsonIssue ? (
              <InlineAlert variant="warning" title={t("settingsPage.common.invalidJsonTitle")} description={jsonIssue} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                {t("settingsPage.reasoning.emptyState")}
              </div>
            ) : (
              items.map((item) => {
                const modelValue = item.model || defaultModelValue
                const showCustomModel =
                  modelValue !== defaultModelValue && !models.includes(modelValue)
                const disableModelSelect = !hasModels && !showCustomModel

                return (
                  <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={modelValue}
                        onValueChange={(value) =>
                          onUpdateItem(item.id, {
                            model: value === defaultModelValue ? "" : value,
                          })
                        }
                        disabled={disableModelSelect}
                      >
                        <SelectTrigger className="min-w-[220px]">
                          <SelectValue
                            placeholder={
                              hasModels
                                ? t("settingsPage.common.selectModelPlaceholder")
                                : t("settingsPage.common.noModelsAvailable")
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={defaultModelValue}>
                            {t("settingsPage.common.defaultOption")}
                          </SelectItem>
                          {showCustomModel ? (
                            <SelectItem value={modelValue}>
                              {t("settingsPage.common.customModel", { value: modelValue })}
                            </SelectItem>
                          ) : null}
                          {models.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={item.effort}
                        onValueChange={(value) =>
                          onUpdateItem(item.id, { effort: value as ReasoningEffort })
                        }
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REASONING_EFFORTS.map((effort) => (
                            <SelectItem key={effort} value={effort}>
                              {effort}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRemoveItem(item.id)}
                      >
                        {t("settingsPage.common.remove")}
                      </Button>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {t("settingsPage.reasoning.itemHint")}
                    </div>
                  </div>
                )
              })
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              {t("settingsPage.reasoning.addButton")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type ExtraPromptsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<ExtraPromptItem>
  models: Array<string>
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ExtraPromptItem>) => void
}

function ExtraPromptsCard({
  mode,
  json,
  jsonIssue,
  items,
  models,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ExtraPromptsCardProps): React.JSX.Element {
  const defaultModelValue = "__default__"
  const hasModels = models.length > 0
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.prompts.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.prompts.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            {t("settingsPage.prompts.hint")}
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">{t("settingsPage.common.jsonMode")}</Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[200px] lg:min-h-[140px] max-h-[40vh] overflow-auto font-mono text-xs"
              placeholder={t("settingsPage.prompts.jsonPlaceholder")}
            />
            {jsonIssue ? (
              <InlineAlert variant="warning" title={t("settingsPage.common.invalidJsonTitle")} description={jsonIssue} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">{t("settingsPage.prompts.emptyState")}</div>
            ) : (
              items.map((item) => {
                const modelValue = item.model || defaultModelValue
                const showCustomModel =
                  modelValue !== defaultModelValue && !models.includes(modelValue)
                const disableModelSelect = !hasModels && !showCustomModel

                return (
                  <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={modelValue}
                        onValueChange={(value) =>
                          onUpdateItem(item.id, {
                            model: value === defaultModelValue ? "" : value,
                          })
                        }
                        disabled={disableModelSelect}
                      >
                        <SelectTrigger className="min-w-[220px]">
                          <SelectValue
                            placeholder={
                              hasModels
                                ? t("settingsPage.common.selectModelPlaceholder")
                                : t("settingsPage.common.noModelsAvailable")
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={defaultModelValue}>
                            {t("settingsPage.common.defaultOption")}
                          </SelectItem>
                          {showCustomModel ? (
                            <SelectItem value={modelValue}>
                              {t("settingsPage.common.customModel", { value: modelValue })}
                            </SelectItem>
                          ) : null}
                          {models.map((model) => (
                            <SelectItem key={model} value={model}>
                              {model}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRemoveItem(item.id)}
                      >
                        {t("settingsPage.common.remove")}
                      </Button>
                    </div>
                    <Textarea
                      value={item.prompt}
                      onChange={(e) => onUpdateItem(item.id, { prompt: e.target.value })}
                      className="min-h-[120px] lg:min-h-[96px] max-h-[30vh] overflow-auto font-mono text-xs"
                      placeholder={t("settingsPage.prompts.promptPlaceholder")}
                    />
                    <div className="text-muted-foreground text-xs">
                      {t("settingsPage.prompts.itemHint")}
                    </div>
                  </div>
                )
              })
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              {t("settingsPage.prompts.addButton")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type ModelAliasesCardProps = {
  allowOriginalModelNamesForAliases: boolean
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: Array<ModelAliasItem>
  models: Array<string>
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
}

type ModelAliasesHeaderProps = {
  allowOriginalModelNamesForAliases: boolean
  mode: JsonMode
  onToggleMode: (next: boolean) => void
}

type ModelAliasesJsonEditorProps = {
  json: string
  jsonIssue: string | null
  onJsonChange: (value: string) => void
}

type ModelAliasItemCardProps = {
  item: ModelAliasItem
  models: Array<string>
  emptyTargetValue: string
  allowOriginalDefaultValue: string
  hasModels: boolean
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
  onRemoveItem: (id: string) => void
}

type ModelAliasesListProps = {
  items: Array<ModelAliasItem>
  models: Array<string>
  emptyTargetValue: string
  allowOriginalDefaultValue: string
  hasModels: boolean
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
}

function ModelAliasesHeader({
  allowOriginalModelNamesForAliases,
  mode,
  onToggleMode,
}: ModelAliasesHeaderProps): React.JSX.Element {
  const { t } = useTranslation()

  const defaultBehavior = allowOriginalModelNamesForAliases
    ? t("settingsPage.common.allow")
    : t("settingsPage.common.block")

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-muted-foreground text-xs">
        {t("settingsPage.aliases.defaultBehaviorHint", { behavior: defaultBehavior })}
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
        <Label className="text-muted-foreground text-xs">{t("settingsPage.common.jsonMode")}</Label>
      </div>
    </div>
  )
}

function ModelAliasesJsonEditor({
  json,
  jsonIssue,
  onJsonChange,
}: ModelAliasesJsonEditorProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      <Textarea
        value={json}
        onChange={(e) => onJsonChange(e.target.value)}
        className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
        placeholder={t("settingsPage.aliases.jsonPlaceholder")}
      />
      {jsonIssue ? (
        <InlineAlert
          variant="warning"
          title={t("settingsPage.common.invalidJsonTitle")}
          description={jsonIssue}
        />
      ) : null}
    </div>
  )
}

function ModelAliasItemCard({
  item,
  models,
  emptyTargetValue,
  allowOriginalDefaultValue,
  hasModels,
  onUpdateItem,
  onRemoveItem,
}: ModelAliasItemCardProps): React.JSX.Element {
  const { t } = useTranslation()

  const targetValue = item.target || emptyTargetValue
  const showCustomTarget = targetValue !== emptyTargetValue && !models.includes(targetValue)
  const disableTargetSelect = !hasModels && !showCustomTarget
  const allowOriginalValue =
    item.allowOriginal === undefined
      ? allowOriginalDefaultValue
      : item.allowOriginal
        ? "allow"
        : "block"

  return (
    <div className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[180px]"
          placeholder={t("settingsPage.aliases.aliasPlaceholder")}
          value={item.alias}
          onChange={(e) => onUpdateItem(item.id, { alias: e.target.value })}
        />
        <Select
          value={targetValue}
          onValueChange={(value) =>
            onUpdateItem(item.id, {
              target: value === emptyTargetValue ? "" : value,
            })
          }
          disabled={disableTargetSelect}
        >
          <SelectTrigger className="min-w-[220px]">
            <SelectValue
              placeholder={
                hasModels
                  ? t("settingsPage.aliases.selectTargetPlaceholder")
                  : t("settingsPage.common.noModelsAvailable")
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={emptyTargetValue}>{t("settingsPage.aliases.selectOption")}</SelectItem>
            {showCustomTarget ? (
              <SelectItem value={targetValue}>
                {t("settingsPage.common.customModel", { value: targetValue })}
              </SelectItem>
            ) : null}
            {models.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={allowOriginalValue}
          onValueChange={(value) =>
            onUpdateItem(item.id, {
              allowOriginal:
                value === allowOriginalDefaultValue
                  ? undefined
                  : value === "allow",
            })
          }
        >
          <SelectTrigger className="min-w-[200px]">
            <SelectValue placeholder={t("settingsPage.aliases.originalModelPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={allowOriginalDefaultValue}>{t("settingsPage.aliases.useDefault")}</SelectItem>
            <SelectItem value="allow">{t("settingsPage.aliases.allowOriginal")}</SelectItem>
            <SelectItem value="block">{t("settingsPage.aliases.blockOriginal")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRemoveItem(item.id)}
        >
          {t("settingsPage.common.remove")}
        </Button>
      </div>
    </div>
  )
}

function ModelAliasesList({
  items,
  models,
  emptyTargetValue,
  allowOriginalDefaultValue,
  hasModels,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ModelAliasesListProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <div className="text-muted-foreground text-sm">{t("settingsPage.aliases.emptyState")}</div>
      ) : (
        items.map((item) => (
          <ModelAliasItemCard
            key={item.id}
            item={item}
            models={models}
            emptyTargetValue={emptyTargetValue}
            allowOriginalDefaultValue={allowOriginalDefaultValue}
            hasModels={hasModels}
            onUpdateItem={onUpdateItem}
            onRemoveItem={onRemoveItem}
          />
        ))
      )}

      <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
        {t("settingsPage.aliases.addButton")}
      </Button>
    </div>
  )
}

function ModelAliasesCard({
  allowOriginalModelNamesForAliases,
  mode,
  json,
  jsonIssue,
  items,
  models,
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ModelAliasesCardProps): React.JSX.Element {
  const emptyTargetValue = "__target__"
  const allowOriginalDefaultValue = "__allow_original_default__"
  const hasModels = models.length > 0
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.aliases.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.aliases.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <ModelAliasesHeader
          allowOriginalModelNamesForAliases={allowOriginalModelNamesForAliases}
          mode={mode}
          onToggleMode={onToggleMode}
        />

        {mode === "json" ? (
          <ModelAliasesJsonEditor
            json={json}
            jsonIssue={jsonIssue}
            onJsonChange={onJsonChange}
          />
        ) : (
          <ModelAliasesList
            items={items}
            models={models}
            emptyTargetValue={emptyTargetValue}
            allowOriginalDefaultValue={allowOriginalDefaultValue}
            hasModels={hasModels}
            onAddItem={onAddItem}
            onRemoveItem={onRemoveItem}
            onUpdateItem={onUpdateItem}
          />
        )}
      </CardContent>
    </Card>
  )
}

type AdvancedSettingsCardProps = {
  loadBalancingEnabled: boolean
  allowOriginalModelNamesForAliases: boolean
  useFunctionApplyPatch: boolean
  forceAgent: boolean
  compactUseSmallModel: boolean
  messageStartInputTokensFallback: boolean
  onToggleLoadBalancing: (value: boolean) => void
  onToggleAllowOriginalModelNamesForAliases: (value: boolean) => void
  onToggleUseFunctionApplyPatch: (value: boolean) => void
  onToggleForceAgent: (value: boolean) => void
  onToggleCompactUseSmallModel: (value: boolean) => void
  onToggleMessageStartInputTokensFallback: (value: boolean) => void
}

function AdvancedSettingsCard({
  loadBalancingEnabled,
  allowOriginalModelNamesForAliases,
  useFunctionApplyPatch,
  forceAgent,
  compactUseSmallModel,
  messageStartInputTokensFallback,
  onToggleLoadBalancing,
  onToggleAllowOriginalModelNamesForAliases,
  onToggleUseFunctionApplyPatch,
  onToggleForceAgent,
  onToggleCompactUseSmallModel,
  onToggleMessageStartInputTokensFallback,
}: AdvancedSettingsCardProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t("settingsPage.advanced.title")}</CardTitle>
        <CardDescription className="hidden sm:block">
          {t("settingsPage.advanced.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.loadBalancing.freeModelLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.loadBalancing.freeModelHint")}
            </div>
          </div>
          <Switch
            checked={loadBalancingEnabled}
            onCheckedChange={onToggleLoadBalancing}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.allowOriginalModelNamesLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.allowOriginalModelNamesHint")}
            </div>
          </div>
          <Switch
            checked={allowOriginalModelNamesForAliases}
            onCheckedChange={onToggleAllowOriginalModelNamesForAliases}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.useFunctionApplyPatchLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.useFunctionApplyPatchHint")}
            </div>
          </div>
          <Switch
            checked={useFunctionApplyPatch}
            onCheckedChange={onToggleUseFunctionApplyPatch}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.forceAgentLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.forceAgentHint")}
            </div>
          </div>
          <Switch checked={forceAgent} onCheckedChange={onToggleForceAgent} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">{t("settingsPage.advanced.compactUseSmallModelLabel")}</div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.compactUseSmallModelHint")}
            </div>
          </div>
          <Switch
            checked={compactUseSmallModel}
            onCheckedChange={onToggleCompactUseSmallModel}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">
              {t("settingsPage.advanced.messageStartInputTokensFallbackLabel")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("settingsPage.advanced.messageStartInputTokensFallbackHint")}
            </div>
          </div>
          <Switch
            checked={messageStartInputTokensFallback}
            onCheckedChange={onToggleMessageStartInputTokensFallback}
          />
        </div>
      </CardContent>
    </Card>
  )
}

type SettingsPageViewProps = {
  loading: boolean
  saving: boolean
  error: string | null
  configPath: string | null
  canSave: boolean
  onReload: () => void
  onSave: () => void
  hasModels: boolean
  smallModelLabel: string
  smallModelValue: string
  smallModelInputValue: string
  models: Array<string>
  apiKeyValue: string
  envOverrideNote: string
  onSmallModelSelect: (value: string) => void
  onSmallModelInput: (value: string) => void
  onApiKeyChange: (value: string) => void
  loadBalancingEnabled: boolean
  onLoadBalancingToggle: (value: boolean) => void
  reasoningMode: JsonMode
  reasoningJson: string
  reasoningJsonIssue: string | null
  reasoningItems: Array<ReasoningItem>
  onReasoningToggleMode: (next: boolean) => void
  onReasoningJsonChange: (value: string) => void
  onReasoningAddItem: () => void
  onReasoningRemoveItem: (id: string) => void
  onReasoningUpdateItem: (id: string, value: Partial<ReasoningItem>) => void
  extraMode: JsonMode
  extraJson: string
  extraJsonIssue: string | null
  extraItems: Array<ExtraPromptItem>
  onExtraToggleMode: (next: boolean) => void
  onExtraJsonChange: (value: string) => void
  onExtraAddItem: () => void
  onExtraRemoveItem: (id: string) => void
  onExtraUpdateItem: (id: string, value: Partial<ExtraPromptItem>) => void
  aliasMode: JsonMode
  aliasJson: string
  aliasJsonIssue: string | null
  aliasItems: Array<ModelAliasItem>
  onAliasToggleMode: (next: boolean) => void
  onAliasJsonChange: (value: string) => void
  onAliasAddItem: () => void
  onAliasRemoveItem: (id: string) => void
  onAliasUpdateItem: (id: string, value: Partial<ModelAliasItem>) => void
  allowOriginalModelNamesForAliases: boolean
  useFunctionApplyPatch: boolean
  forceAgent: boolean
  compactUseSmallModel: boolean
  messageStartInputTokensFallback: boolean
  onAllowOriginalModelNamesForAliasesToggle: (value: boolean) => void
  onUseFunctionApplyPatchToggle: (value: boolean) => void
  onForceAgentToggle: (value: boolean) => void
  onCompactUseSmallModelToggle: (value: boolean) => void
  onMessageStartInputTokensFallbackToggle: (value: boolean) => void
}

function useSettingsPageState(): SettingsPageViewProps {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configPath, setConfigPath] = useState<string | null>(null)

  const [models, setModels] = useState<Array<string>>([])
  const [draft, setDraft] = useState<AdminConfig>({})

  const extraEditor = useExtraPromptEditor((record) =>
    setDraft((prev) => ({ ...prev, extraPrompts: record })),
  )
  const reasoningEditor = useReasoningEditor((record) =>
    setDraft((prev) => ({ ...prev, modelReasoningEfforts: record })),
  )

  const aliasEditor = useModelAliasEditor((record) =>
    setDraft((prev) => ({ ...prev, modelAliases: record })),
  )

  const {
    mode: extraMode,
    items: extraItems,
    json: extraJson,
    jsonIssue: extraJsonIssue,
    onToggleMode: onExtraToggleMode,
    onJsonChange: onExtraJsonChange,
    onAddItem: onExtraAddItem,
    onRemoveItem: onExtraRemoveItem,
    onUpdateItem: onExtraUpdateItem,
    setFromRecord: setExtraFromRecord,
  } = extraEditor

  const {
    mode: reasoningMode,
    items: reasoningItems,
    json: reasoningJson,
    jsonIssue: reasoningJsonIssue,
    onToggleMode: onReasoningToggleMode,
    onJsonChange: onReasoningJsonChange,
    onAddItem: onReasoningAddItem,
    onRemoveItem: onReasoningRemoveItem,
    onUpdateItem: onReasoningUpdateItem,
    setFromRecord: setReasoningFromRecord,
  } = reasoningEditor

  const {
    mode: aliasMode,
    items: aliasItems,
    json: aliasJson,
    jsonIssue: aliasJsonIssue,
    onToggleMode: onAliasToggleMode,
    onJsonChange: onAliasJsonChange,
    onAddItem: onAliasAddItem,
    onRemoveItem: onAliasRemoveItem,
    onUpdateItem: onAliasUpdateItem,
    setFromRecord: setAliasFromRecord,
  } = aliasEditor

  const applyConfigResponse = useCallback(
    (config: AdminConfigResponse) => {
      const { _configPath, ...configData } = config
      const aliasItems = aliasItemsFromRecord(configData.modelAliases)
      const normalizedAliases = aliasRecordFromItems(aliasItems)

      setConfigPath(_configPath ?? null)
      setDraft({ ...configData, modelAliases: normalizedAliases })
      setExtraFromRecord(configData.extraPrompts)
      setReasoningFromRecord(configData.modelReasoningEfforts)
      setAliasFromRecord(normalizedAliases)
    },
    [setExtraFromRecord, setReasoningFromRecord, setAliasFromRecord],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const [configRes, modelsRes] = await Promise.allSettled([
        getAdminConfig(),
        getAdminModels(),
      ])

      if (configRes.status === "fulfilled") {
        applyConfigResponse(configRes.value)
      } else {
        throw configRes.reason
      }

      if (modelsRes.status === "fulfilled") {
        setModels(modelsRes.value.items ?? [])
      } else {
        setModels([])
        toast.error(i18n.t("settingsPage.toast.loadModelsFailed"), {
          description:
            modelsRes.reason instanceof Error ? modelsRes.reason.message : String(modelsRes.reason),
        })
      }
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error(i18n.t("settingsPage.toast.loadConfigFailed"), { description: msg })
    } finally {
      setLoading(false)
    }
  }, [applyConfigResponse])

  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)

    try {
      const updated = await updateAdminConfig(draft)
      applyConfigResponse(updated)
      toast.success(i18n.t("settingsPage.toast.configSaved"))
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error(i18n.t("settingsPage.toast.saveConfigFailed"), { description: msg })
    } finally {
      setSaving(false)
    }
  }, [applyConfigResponse, draft])

  const onReload = useCallback(() => {
    void load()
  }, [load])

  const onSave = useCallback(() => {
    void save()
  }, [save])

  const handleSmallModelSelect = useCallback(
    (value: string) => {
      setDraft((prev) => ({
        ...prev,
        smallModel: value === "__default__" ? "" : value,
      }))
    },
    [setDraft],
  )

  const handleSmallModelInput = useCallback(
    (value: string) => {
      setDraft((prev) => ({ ...prev, smallModel: value }))
    },
    [setDraft],
  )

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setDraft((prev) => ({ ...prev, apiKey: value }))
    },
    [setDraft],
  )

  const handleLoadBalancingToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, freeModelLoadBalancing: value }))
    },
    [setDraft],
  )

  const handleAllowOriginalModelNamesForAliasesToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, allowOriginalModelNamesForAliases: value }))
    },
    [setDraft],
  )

  const handleUseFunctionApplyPatchToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, useFunctionApplyPatch: value }))
    },
    [setDraft],
  )

  const handleForceAgentToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, forceAgent: value }))
    },
    [setDraft],
  )

  const handleCompactUseSmallModelToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, compactUseSmallModel: value }))
    },
    [setDraft],
  )

  const handleMessageStartInputTokensFallbackToggle = useCallback(
    (value: boolean) => {
      setDraft((prev) => ({ ...prev, messageStartInputTokensFallback: value }))
    },
    [setDraft],
  )

  const hasModels = models.length > 0
  const smallModelValue = draft.smallModel ? draft.smallModel : "__default__"
  const canSave =
    !saving
    && !loading
    && !(extraMode === "json" && extraJsonIssue)
    && !(reasoningMode === "json" && reasoningJsonIssue)
    && !(aliasMode === "json" && aliasJsonIssue)

  const envOverrideNote = t("settingsPage.envOverrideNote", {
    env: "COPILOT_API_KEY",
  })

  const smallModelLabel = hasModels
    ? t("settingsPage.general.smallModel")
    : t("settingsPage.general.smallModelManual")
  const smallModelInputValue = draft.smallModel ?? ""
  const apiKeyValue = draft.apiKey ?? ""

  const loadBalancingEnabled = draft.freeModelLoadBalancing ?? true
  const allowOriginalModelNamesForAliases =
    draft.allowOriginalModelNamesForAliases ?? false
  const useFunctionApplyPatch = draft.useFunctionApplyPatch ?? true
  const forceAgent = draft.forceAgent ?? false
  const compactUseSmallModel = draft.compactUseSmallModel ?? true
  const messageStartInputTokensFallback =
    draft.messageStartInputTokensFallback ?? false

  return {
    loading,
    saving,
    error,
    configPath,
    canSave,
    onReload,
    onSave,
    hasModels,
    smallModelLabel,
    smallModelValue,
    smallModelInputValue,
    models,
    apiKeyValue,
    envOverrideNote,
    onSmallModelSelect: handleSmallModelSelect,
    onSmallModelInput: handleSmallModelInput,
    onApiKeyChange: handleApiKeyChange,
    loadBalancingEnabled,
    onLoadBalancingToggle: handleLoadBalancingToggle,
    allowOriginalModelNamesForAliases,
    reasoningMode,
    reasoningJson,
    reasoningJsonIssue,
    reasoningItems,
    onReasoningToggleMode,
    onReasoningJsonChange,
    onReasoningAddItem,
    onReasoningRemoveItem,
    onReasoningUpdateItem,
    extraMode,
    extraJson,
    extraJsonIssue,
    extraItems,
    onExtraToggleMode,
    onExtraJsonChange,
    onExtraAddItem,
    onExtraRemoveItem,
    onExtraUpdateItem,
    aliasMode,
    aliasJson,
    aliasJsonIssue,
    aliasItems,
    onAliasToggleMode,
    onAliasJsonChange,
    onAliasAddItem,
    onAliasRemoveItem,
    onAliasUpdateItem,
    useFunctionApplyPatch,
    forceAgent,
    compactUseSmallModel,
    messageStartInputTokensFallback,
    onAllowOriginalModelNamesForAliasesToggle:
      handleAllowOriginalModelNamesForAliasesToggle,
    onUseFunctionApplyPatchToggle: handleUseFunctionApplyPatchToggle,
    onForceAgentToggle: handleForceAgentToggle,
    onCompactUseSmallModelToggle: handleCompactUseSmallModelToggle,
    onMessageStartInputTokensFallbackToggle:
      handleMessageStartInputTokensFallbackToggle,
  }
}

function SettingsPageView({
  loading,
  saving,
  error,
  configPath,
  canSave,
  onReload,
  onSave,
  hasModels,
  smallModelLabel,
  smallModelValue,
  smallModelInputValue,
  models,
  apiKeyValue,
  envOverrideNote,
  onSmallModelSelect,
  onSmallModelInput,
  onApiKeyChange,
  loadBalancingEnabled,
  onLoadBalancingToggle,
  reasoningMode,
  reasoningJson,
  reasoningJsonIssue,
  reasoningItems,
  onReasoningToggleMode,
  onReasoningJsonChange,
  onReasoningAddItem,
  onReasoningRemoveItem,
  onReasoningUpdateItem,
  extraMode,
  extraJson,
  extraJsonIssue,
  extraItems,
  onExtraToggleMode,
  onExtraJsonChange,
  onExtraAddItem,
  onExtraRemoveItem,
  onExtraUpdateItem,
  aliasMode,
  aliasJson,
  aliasJsonIssue,
  aliasItems,
  onAliasToggleMode,
  onAliasJsonChange,
  onAliasAddItem,
  onAliasRemoveItem,
  onAliasUpdateItem,
  allowOriginalModelNamesForAliases,
  useFunctionApplyPatch,
  forceAgent,
  compactUseSmallModel,
  messageStartInputTokensFallback,
  onAllowOriginalModelNamesForAliasesToggle,
  onUseFunctionApplyPatchToggle,
  onForceAgentToggle,
  onCompactUseSmallModelToggle,
  onMessageStartInputTokensFallbackToggle,
}: SettingsPageViewProps): React.JSX.Element {
  const { t } = useTranslation()

  const sections = useMemo<Array<SettingsSection>>(() => {
    return [
      { id: "general", label: t("settingsPage.sections.general") },
      { id: "reasoning", label: t("settingsPage.sections.reasoning") },
      { id: "aliases", label: t("settingsPage.sections.aliases") },
      { id: "prompts", label: t("settingsPage.sections.prompts") },
      { id: "advanced", label: t("settingsPage.sections.advanced") },
    ]
  }, [t])

  const { activeSection, registerSection, scrollToSection } = useActiveSection({
    sectionIds: [...SETTINGS_SECTION_IDS],
  })

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold">{t("nav.settings")}</div>
          <div className="text-muted-foreground text-sm">{t("settingsPage.subtitle")}</div>
        </div>

        <div className="ml-auto flex flex-col items-end gap-1 text-right">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReload}
              disabled={loading || saving}
            >
              {loading ? t("common.refreshing") : t("common.refresh")}
            </Button>
          </div>
          {configPath ? (
            <div className="text-muted-foreground text-xs leading-tight hidden sm:block">
              {t("settingsPage.configPath", { path: configPath })}
            </div>
          ) : null}
          <div className="text-muted-foreground text-xs leading-tight hidden sm:block">
            {t("settingsPage.note")}
          </div>
        </div>
      </div>

      {error ? (
        <InlineAlert
          variant="error"
          title={t("settingsPage.errorTitle")}
          description={error}
          actionLabel={t("common.retry")}
          onAction={onReload}
        />
      ) : null}

      {/* Main Layout: Sidebar Navigation + Content */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Sidebar Navigation (desktop only) */}
        <aside className="hidden lg:block lg:col-span-2">
          <SettingsNavigation
            sections={sections}
            activeSection={activeSection}
            onSectionClick={scrollToSection}
          />
        </aside>

        {/* Content Area */}
        <main className="space-y-6 lg:col-span-10">
          {/* General Settings */}
          <SettingsSectionCard
            id="general"
            isActive={activeSection === "general"}
            ref={(el) => registerSection("general", el)}
          >
            <GeneralSettingsCard
              hasModels={hasModels}
              smallModelLabel={smallModelLabel}
              smallModelValue={smallModelValue}
              smallModelInputValue={smallModelInputValue}
              models={models}
              apiKeyValue={apiKeyValue}
              envOverrideNote={envOverrideNote}
              onSmallModelSelect={onSmallModelSelect}
              onSmallModelInput={onSmallModelInput}
              onApiKeyChange={onApiKeyChange}
            />
          </SettingsSectionCard>


          {/* Reasoning Efforts */}
          <SettingsSectionCard
            id="reasoning"
            isActive={activeSection === "reasoning"}
            ref={(el) => registerSection("reasoning", el)}
          >
            <ReasoningEffortsCard
              mode={reasoningMode}
              json={reasoningJson}
              jsonIssue={reasoningJsonIssue}
              items={reasoningItems}
              models={models}
              onToggleMode={onReasoningToggleMode}
              onJsonChange={onReasoningJsonChange}
              onAddItem={onReasoningAddItem}
              onRemoveItem={onReasoningRemoveItem}
              onUpdateItem={onReasoningUpdateItem}
            />
          </SettingsSectionCard>

          {/* Model Aliases */}
          <SettingsSectionCard
            id="aliases"
            isActive={activeSection === "aliases"}
            ref={(el) => registerSection("aliases", el)}
          >
            <ModelAliasesCard
              allowOriginalModelNamesForAliases={allowOriginalModelNamesForAliases}
              mode={aliasMode}
              json={aliasJson}
              jsonIssue={aliasJsonIssue}
              items={aliasItems}
              models={models}
              onToggleMode={onAliasToggleMode}
              onJsonChange={onAliasJsonChange}
              onAddItem={onAliasAddItem}
              onRemoveItem={onAliasRemoveItem}
              onUpdateItem={onAliasUpdateItem}
            />
          </SettingsSectionCard>

          {/* Extra Prompts */}
          <SettingsSectionCard
            id="prompts"
            isActive={activeSection === "prompts"}
            ref={(el) => registerSection("prompts", el)}
          >
            <ExtraPromptsCard
              mode={extraMode}
              json={extraJson}
              jsonIssue={extraJsonIssue}
              items={extraItems}
              models={models}
              onToggleMode={onExtraToggleMode}
              onJsonChange={onExtraJsonChange}
              onAddItem={onExtraAddItem}
              onRemoveItem={onExtraRemoveItem}
              onUpdateItem={onExtraUpdateItem}
            />
          </SettingsSectionCard>

          {/* Advanced Settings */}
          <SettingsSectionCard
            id="advanced"
            isActive={activeSection === "advanced"}
            ref={(el) => registerSection("advanced", el)}
          >
            <AdvancedSettingsCard
              loadBalancingEnabled={loadBalancingEnabled}
              allowOriginalModelNamesForAliases={allowOriginalModelNamesForAliases}
              useFunctionApplyPatch={useFunctionApplyPatch}
              forceAgent={forceAgent}
              compactUseSmallModel={compactUseSmallModel}
              messageStartInputTokensFallback={messageStartInputTokensFallback}
              onToggleLoadBalancing={onLoadBalancingToggle}
              onToggleAllowOriginalModelNamesForAliases={
                onAllowOriginalModelNamesForAliasesToggle
              }
              onToggleUseFunctionApplyPatch={onUseFunctionApplyPatchToggle}
              onToggleForceAgent={onForceAgentToggle}
              onToggleCompactUseSmallModel={onCompactUseSmallModelToggle}
              onToggleMessageStartInputTokensFallback={
                onMessageStartInputTokensFallbackToggle
              }
            />
          </SettingsSectionCard>
        </main>
      </div>

      {/* Floating Save Button */}
      <FloatingSaveButton
        saving={saving}
        canSave={canSave}
        onSave={onSave}
      />
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const state = useSettingsPageState()
  return <SettingsPageView {...state} />
}
