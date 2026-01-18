import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

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
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RainbowButton } from "@/components/ui/rainbow-button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

const REASONING_EFFORTS: ReasoningEffort[] = [
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
): ExtraPromptItem[] {
  if (!record) return []
  return Object.entries(record).map(([model, prompt]) => ({
    id: createItemId(),
    model,
    prompt,
  }))
}

function reasoningItemsFromRecord(
  record: Record<string, ReasoningEffort> | undefined
): ReasoningItem[] {
  if (!record) return []
  return Object.entries(record).map(([model, effort]) => ({
    id: createItemId(),
    model,
    effort,
  }))
}

function aliasItemsFromRecord(
  record: ModelAliasRecordInput | undefined
): ModelAliasItem[] {
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

function extraPromptRecordFromItems(items: ExtraPromptItem[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const item of items) {
    const key = item.model.trim()
    if (!key) continue
    record[key] = item.prompt
  }
  return record
}

function reasoningRecordFromItems(items: ReasoningItem[]): Record<string, ReasoningEffort> {
  const record: Record<string, ReasoningEffort> = {}
  for (const item of items) {
    const key = item.model.trim()
    if (!key) continue
    record[key] = item.effort
  }
  return record
}

function aliasRecordFromItems(items: ModelAliasItem[]): ModelAliasRecord {
  const record: ModelAliasRecord = {}
  const seen = new Set<string>()

  for (const item of items) {
    const alias = item.alias.trim()
    const target = item.target.trim()
    if (!alias || !target) continue

    const normalizedAlias = alias.toLowerCase()
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

    const record: ModelAliasRecord = {}
    const seen = new Set<string>()

    for (const [rawAlias, rawTarget] of Object.entries(parsed)) {
      const alias = rawAlias.trim()
      if (!alias) {
        return { error: "modelAliases keys must be non-empty strings." }
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

      const normalizedAlias = alias.toLowerCase()
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
  items: ExtraPromptItem[]
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
  items: ReasoningItem[]
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
  items: ModelAliasItem[]
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
  const [items, setItems] = useState<ExtraPromptItem[]>([])
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
    (nextItems: ExtraPromptItem[]) => {
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
  const [items, setItems] = useState<ReasoningItem[]>([])
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
    (nextItems: ReasoningItem[]) => {
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
  const [items, setItems] = useState<ModelAliasItem[]>([])
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
    (nextItems: ModelAliasItem[]) => {
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
  models: string[]
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
  const showCustomModel =
    hasModels
    && smallModelValue !== "__default__"
    && !models.includes(smallModelValue)

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>General</CardTitle>
        <CardDescription className="hidden sm:block">
          Default model routing and API key storage.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">{smallModelLabel}</Label>
          {hasModels ? (
            <Select value={smallModelValue} onValueChange={onSmallModelSelect}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select small model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">(default)</SelectItem>
                {showCustomModel ? (
                  <SelectItem value={smallModelValue}>
                    Custom: {smallModelValue}
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
              placeholder="gpt-5-mini"
              value={smallModelInputValue}
              onChange={(e) => onSmallModelInput(e.target.value)}
            />
          )}
          <div className="text-muted-foreground text-xs">
            Controls which model receives lightweight/free requests when routing.
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-muted-foreground text-xs">API key</Label>
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="sk-..."
            value={apiKeyValue}
            onChange={(e) => onApiKeyChange(e.target.value)}
          />
          <div className="text-muted-foreground text-xs">
            {envOverrideNote} Leave empty to clear config value.
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

type LoadBalancingCardProps = {
  enabled: boolean
  onToggle: (value: boolean) => void
}

function LoadBalancingCard({ enabled, onToggle }: LoadBalancingCardProps): React.JSX.Element {
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>Load balancing</CardTitle>
        <CardDescription className="hidden sm:block">
          Toggle free account load balancing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">Free model load balancing</div>
            <div className="text-muted-foreground text-xs">
              When enabled, distributes free traffic across available accounts.
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={onToggle} />
        </div>
      </CardContent>
    </Card>
  )
}

type ReasoningEffortsCardProps = {
  mode: JsonMode
  json: string
  jsonIssue: string | null
  items: ReasoningItem[]
  models: string[]
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

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>Reasoning efforts</CardTitle>
        <CardDescription className="hidden sm:block">
          Override model reasoning effort levels.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            Define per-model reasoning effort (optional).
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">JSON mode</Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
              placeholder='{ "gpt-5-mini": "low" }'
            />
            {jsonIssue ? (
              <InlineAlert variant="warning" title="Invalid JSON" description={jsonIssue} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">
                No reasoning overrides. Add a model below.
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
                            placeholder={hasModels ? "Select model" : "No models available"}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={defaultModelValue}>(default)</SelectItem>
                          {showCustomModel ? (
                            <SelectItem value={modelValue}>Custom: {modelValue}</SelectItem>
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
                        Remove
                      </Button>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      Overrides reasoning effort for this model.
                    </div>
                  </div>
                )
              })
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              Add model override
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
  items: ExtraPromptItem[]
  models: string[]
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

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>Extra prompts</CardTitle>
        <CardDescription className="hidden sm:block">
          Inject extra system prompts per model.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            Add or edit prompt snippets injected for specific models.
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">JSON mode</Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[200px] lg:min-h-[140px] max-h-[40vh] overflow-auto font-mono text-xs"
              placeholder='{ "gpt-5-mini": "..." }'
            />
            {jsonIssue ? (
              <InlineAlert variant="warning" title="Invalid JSON" description={jsonIssue} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">No extra prompts configured.</div>
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
                            placeholder={hasModels ? "Select model" : "No models available"}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={defaultModelValue}>(default)</SelectItem>
                          {showCustomModel ? (
                            <SelectItem value={modelValue}>Custom: {modelValue}</SelectItem>
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
                        Remove
                      </Button>
                    </div>
                    <Textarea
                      value={item.prompt}
                      onChange={(e) => onUpdateItem(item.id, { prompt: e.target.value })}
                      className="min-h-[120px] lg:min-h-[96px] max-h-[30vh] overflow-auto font-mono text-xs"
                      placeholder="System prompt snippet..."
                    />
                    <div className="text-muted-foreground text-xs">
                      Adds prompt content before model execution.
                    </div>
                  </div>
                )
              })
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              Add prompt
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
  items: ModelAliasItem[]
  models: string[]
  onToggleMode: (next: boolean) => void
  onJsonChange: (value: string) => void
  onAddItem: () => void
  onRemoveItem: (id: string) => void
  onUpdateItem: (id: string, patch: Partial<ModelAliasItem>) => void
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

  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>Model aliases</CardTitle>
        <CardDescription className="hidden sm:block">
          Map friendly alias names to upstream model IDs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-muted-foreground text-xs">
            Default behavior: {allowOriginalModelNamesForAliases ? "allow" : "block"} original
            model IDs. Each alias can override this setting.
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={mode === "json"} onCheckedChange={onToggleMode} />
            <Label className="text-muted-foreground text-xs">JSON mode</Label>
          </div>
        </div>

        {mode === "json" ? (
          <div className="space-y-2">
            <Textarea
              value={json}
              onChange={(e) => onJsonChange(e.target.value)}
              className="min-h-[160px] lg:min-h-[120px] max-h-[36vh] overflow-auto font-mono text-xs"
              placeholder='{ "fast": { "target": "gpt-5-mini", "allowOriginal": true } }'
            />
            {jsonIssue ? (
              <InlineAlert variant="warning" title="Invalid JSON" description={jsonIssue} />
            ) : null}
          </div>
        ) : (
          <div className="space-y-2">
            {items.length === 0 ? (
              <div className="text-muted-foreground text-sm">No model aliases configured.</div>
            ) : (
              items.map((item) => {
                const targetValue = item.target || emptyTargetValue
                const showCustomTarget =
                  targetValue !== emptyTargetValue && !models.includes(targetValue)
                const disableTargetSelect = !hasModels && !showCustomTarget
                const allowOriginalValue =
                  item.allowOriginal === undefined
                    ? allowOriginalDefaultValue
                    : item.allowOriginal
                      ? "allow"
                      : "block"

                return (
                  <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        className="min-w-[180px]"
                        placeholder="Alias"
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
                            placeholder={hasModels ? "Select target model" : "No models available"}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={emptyTargetValue}>(select)</SelectItem>
                          {showCustomTarget ? (
                            <SelectItem value={targetValue}>Custom: {targetValue}</SelectItem>
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
                          <SelectValue placeholder="Original model ID" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={allowOriginalDefaultValue}>Use default</SelectItem>
                          <SelectItem value="allow">Allow original model ID</SelectItem>
                          <SelectItem value="block">Block original model ID</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onRemoveItem(item.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                )
              })
            )}

            <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
              Add alias
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type AdvancedSettingsCardProps = {
  allowOriginalModelNamesForAliases: boolean
  useFunctionApplyPatch: boolean
  forceAgent: boolean
  onToggleAllowOriginalModelNamesForAliases: (value: boolean) => void
  onToggleUseFunctionApplyPatch: (value: boolean) => void
  onToggleForceAgent: (value: boolean) => void
}

function AdvancedSettingsCard({
  allowOriginalModelNamesForAliases,
  useFunctionApplyPatch,
  forceAgent,
  onToggleAllowOriginalModelNamesForAliases,
  onToggleUseFunctionApplyPatch,
  onToggleForceAgent,
}: AdvancedSettingsCardProps): React.JSX.Element {
  return (
    <Card className="gap-4 py-4">
      <CardHeader className="px-4">
        <CardTitle>Advanced</CardTitle>
        <CardDescription className="hidden sm:block">
          Feature flags and experimental toggles.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">Allow original model names</div>
            <div className="text-muted-foreground text-xs">
              Default behavior when aliases do not override original model IDs.
            </div>
          </div>
          <Switch
            checked={allowOriginalModelNamesForAliases}
            onCheckedChange={onToggleAllowOriginalModelNamesForAliases}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">Use function apply_patch</div>
            <div className="text-muted-foreground text-xs">
              Enables function-level patches in responses routing.
            </div>
          </div>
          <Switch checked={useFunctionApplyPatch} onCheckedChange={onToggleUseFunctionApplyPatch} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium">Force agent header</div>
            <div className="text-muted-foreground text-xs">
              Forces agent routing logic even when clients omit hints.
            </div>
          </div>
          <Switch checked={forceAgent} onCheckedChange={onToggleForceAgent} />
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
  models: string[]
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
  reasoningItems: ReasoningItem[]
  onReasoningToggleMode: (next: boolean) => void
  onReasoningJsonChange: (value: string) => void
  onReasoningAddItem: () => void
  onReasoningRemoveItem: (id: string) => void
  onReasoningUpdateItem: (id: string, value: Partial<ReasoningItem>) => void
  extraMode: JsonMode
  extraJson: string
  extraJsonIssue: string | null
  extraItems: ExtraPromptItem[]
  onExtraToggleMode: (next: boolean) => void
  onExtraJsonChange: (value: string) => void
  onExtraAddItem: () => void
  onExtraRemoveItem: (id: string) => void
  onExtraUpdateItem: (id: string, value: Partial<ExtraPromptItem>) => void
  aliasMode: JsonMode
  aliasJson: string
  aliasJsonIssue: string | null
  aliasItems: ModelAliasItem[]
  onAliasToggleMode: (next: boolean) => void
  onAliasJsonChange: (value: string) => void
  onAliasAddItem: () => void
  onAliasRemoveItem: (id: string) => void
  onAliasUpdateItem: (id: string, value: Partial<ModelAliasItem>) => void
  allowOriginalModelNamesForAliases: boolean
  useFunctionApplyPatch: boolean
  forceAgent: boolean
  onAllowOriginalModelNamesForAliasesToggle: (value: boolean) => void
  onUseFunctionApplyPatchToggle: (value: boolean) => void
  onForceAgentToggle: (value: boolean) => void
}

function useSettingsPageState(): SettingsPageViewProps {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configPath, setConfigPath] = useState<string | null>(null)

  const [models, setModels] = useState<string[]>([])
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
        toast.error("Failed to load models", {
          description:
            modelsRes.reason instanceof Error ? modelsRes.reason.message : String(modelsRes.reason),
        })
      }
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error("Failed to load config", { description: msg })
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
      toast.success("Config saved")
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error("Failed to save config", { description: msg })
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

  const hasModels = models.length > 0
  const smallModelValue = draft.smallModel ? draft.smallModel : "__default__"
  const canSave =
    !saving
    && !loading
    && !(extraMode === "json" && extraJsonIssue)
    && !(reasoningMode === "json" && reasoningJsonIssue)
    && !(aliasMode === "json" && aliasJsonIssue)

  const envOverrideNote =
    "Environment variable COPILOT_API_KEY overrides this value when set."

  const smallModelLabel = hasModels ? "Small model" : "Small model (manual)"
  const smallModelInputValue = draft.smallModel ?? ""
  const apiKeyValue = draft.apiKey ?? ""

  const loadBalancingEnabled = draft.freeModelLoadBalancing ?? true
  const allowOriginalModelNamesForAliases =
    draft.allowOriginalModelNamesForAliases ?? false
  const useFunctionApplyPatch = draft.useFunctionApplyPatch ?? true
  const forceAgent = draft.forceAgent ?? false

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
    onAllowOriginalModelNamesForAliasesToggle:
      handleAllowOriginalModelNamesForAliasesToggle,
    onUseFunctionApplyPatchToggle: handleUseFunctionApplyPatchToggle,
    onForceAgentToggle: handleForceAgentToggle,
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
  onAllowOriginalModelNamesForAliasesToggle,
  onUseFunctionApplyPatchToggle,
  onForceAgentToggle,
}: SettingsPageViewProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold">Settings</div>
          <div className="text-muted-foreground text-sm">
            Manage config.json and apply updates instantly.
          </div>
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
              {loading ? "Reloading..." : "Reload"}
            </Button>
            <RainbowButton type="button" size="sm" onClick={onSave} disabled={!canSave}>
              {saving ? "Saving..." : "Save"}
            </RainbowButton>
          </div>
          {configPath ? (
            <div className="text-muted-foreground text-xs leading-tight hidden sm:block">
              Config path: {configPath}
            </div>
          ) : null}
          <div className="text-muted-foreground text-xs leading-tight hidden sm:block">
            Changes apply to config.json immediately. Environment variables take precedence.
          </div>
        </div>
      </div>

      {error ? (
        <InlineAlert
          variant="error"
          title="Settings error"
          description={error}
          actionLabel="Retry"
          onAction={onReload}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 auto-rows-min">
        <div className="space-y-4 lg:col-span-8">
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

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
          </div>
        </div>

        <aside className="space-y-4 self-start lg:col-span-4 lg:sticky lg:top-6">
          <LoadBalancingCard enabled={loadBalancingEnabled} onToggle={onLoadBalancingToggle} />

          <AdvancedSettingsCard
            allowOriginalModelNamesForAliases={allowOriginalModelNamesForAliases}
            useFunctionApplyPatch={useFunctionApplyPatch}
            forceAgent={forceAgent}
            onToggleAllowOriginalModelNamesForAliases={
              onAllowOriginalModelNamesForAliasesToggle
            }
            onToggleUseFunctionApplyPatch={onUseFunctionApplyPatchToggle}
            onToggleForceAgent={onForceAgentToggle}
          />

        </aside>
      </div>
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const state = useSettingsPageState()
  return <SettingsPageView {...state} />
}
