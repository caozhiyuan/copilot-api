import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminConfig,
  type AdminConfigResponse,
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
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ReasoningEffortsCardProps): React.JSX.Element {
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
              className="min-h-[160px] font-mono text-xs"
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
              items.map((item) => (
                <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      placeholder="model id"
                      value={item.model}
                      onChange={(e) => onUpdateItem(item.id, { model: e.target.value })}
                    />
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
              ))
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
  onToggleMode,
  onJsonChange,
  onAddItem,
  onRemoveItem,
  onUpdateItem,
}: ExtraPromptsCardProps): React.JSX.Element {
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
              className="min-h-[200px] font-mono text-xs"
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
              items.map((item) => (
                <div key={item.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      placeholder="model id"
                      value={item.model}
                      onChange={(e) => onUpdateItem(item.id, { model: e.target.value })}
                    />
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
                    className="min-h-[120px] font-mono text-xs"
                    placeholder="System prompt snippet..."
                  />
                  <div className="text-muted-foreground text-xs">
                    Adds prompt content before model execution.
                  </div>
                </div>
              ))
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

type AdvancedSettingsCardProps = {
  useFunctionApplyPatch: boolean
  forceAgent: boolean
  onToggleUseFunctionApplyPatch: (value: boolean) => void
  onToggleForceAgent: (value: boolean) => void
}

function AdvancedSettingsCard({
  useFunctionApplyPatch,
  forceAgent,
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

export function SettingsPage(): React.JSX.Element {
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

  const {
    mode: extraMode,
    items: extraItems,
    json: extraJson,
    jsonIssue: extraPromptJsonIssue,
    onToggleMode: toggleExtraMode,
    onJsonChange: onExtraJsonChange,
    onAddItem: handleExtraItemAdd,
    onRemoveItem: handleExtraItemRemove,
    onUpdateItem: handleExtraItemUpdate,
    setFromRecord: setExtraFromRecord,
  } = extraEditor

  const {
    mode: reasoningMode,
    items: reasoningItems,
    json: reasoningJson,
    jsonIssue: reasoningJsonIssue,
    onToggleMode: toggleReasoningMode,
    onJsonChange: onReasoningJsonChange,
    onAddItem: handleReasoningItemAdd,
    onRemoveItem: handleReasoningItemRemove,
    onUpdateItem: handleReasoningItemUpdate,
    setFromRecord: setReasoningFromRecord,
  } = reasoningEditor

  const applyConfigResponse = useCallback(
    (config: AdminConfigResponse) => {
      const { _configPath, ...configData } = config
      setConfigPath(_configPath ?? null)
      setDraft(configData)
      setExtraFromRecord(configData.extraPrompts)
      setReasoningFromRecord(configData.modelReasoningEfforts)
    },
    [setExtraFromRecord, setReasoningFromRecord],
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

  const hasModels = models.length > 0
  const smallModelValue = draft.smallModel ? draft.smallModel : "__default__"
  const canSave =
    !saving
    && !loading
    && !(extraMode === "json" && extraPromptJsonIssue)
    && !(reasoningMode === "json" && reasoningJsonIssue)

  const envOverrideNote =
    "Environment variable COPILOT_API_KEY overrides this value when set."

  const smallModelLabel = hasModels ? "Small model" : "Small model (manual)"
  const smallModelInputValue = draft.smallModel ?? ""
  const apiKeyValue = draft.apiKey ?? ""

  async function save(): Promise<void> {
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
  }

  function handleSmallModelSelect(value: string): void {
    setDraft((prev) => ({
      ...prev,
      smallModel: value === "__default__" ? "" : value,
    }))
  }

  function handleSmallModelInput(value: string): void {
    setDraft((prev) => ({ ...prev, smallModel: value }))
  }

  function handleApiKeyChange(value: string): void {
    setDraft((prev) => ({ ...prev, apiKey: value }))
  }

  function handleLoadBalancingToggle(value: boolean): void {
    setDraft((prev) => ({ ...prev, freeModelLoadBalancing: value }))
  }

  function handleUseFunctionApplyPatchToggle(value: boolean): void {
    setDraft((prev) => ({ ...prev, useFunctionApplyPatch: value }))
  }

  function handleForceAgentToggle(value: boolean): void {
    setDraft((prev) => ({ ...prev, forceAgent: value }))
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="text-lg font-semibold">Settings</div>
          <div className="text-muted-foreground text-sm">
            Manage config.json and apply updates instantly.
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading || saving}
          >
            {loading ? "Reloading..." : "Reload"}
          </Button>
          <RainbowButton type="button" size="sm" onClick={() => void save()} disabled={!canSave}>
            {saving ? "Saving..." : "Save"}
          </RainbowButton>
        </div>
      </div>

      {configPath ? (
        <div className="text-muted-foreground text-xs">Config path: {configPath}</div>
      ) : null}

      {error ? (
        <InlineAlert
          variant="error"
          title="Settings error"
          description={error}
          actionLabel="Retry"
          onAction={() => void load()}
        />
      ) : null}

      <GeneralSettingsCard
        hasModels={hasModels}
        smallModelLabel={smallModelLabel}
        smallModelValue={smallModelValue}
        smallModelInputValue={smallModelInputValue}
        models={models}
        apiKeyValue={apiKeyValue}
        envOverrideNote={envOverrideNote}
        onSmallModelSelect={handleSmallModelSelect}
        onSmallModelInput={handleSmallModelInput}
        onApiKeyChange={handleApiKeyChange}
      />

      <LoadBalancingCard
        enabled={draft.freeModelLoadBalancing ?? true}
        onToggle={handleLoadBalancingToggle}
      />

      <ReasoningEffortsCard
        mode={reasoningMode}
        json={reasoningJson}
        jsonIssue={reasoningJsonIssue}
        items={reasoningItems}
        onToggleMode={toggleReasoningMode}
        onJsonChange={onReasoningJsonChange}
        onAddItem={handleReasoningItemAdd}
        onRemoveItem={handleReasoningItemRemove}
        onUpdateItem={handleReasoningItemUpdate}
      />

      <ExtraPromptsCard
        mode={extraMode}
        json={extraJson}
        jsonIssue={extraPromptJsonIssue}
        items={extraItems}
        onToggleMode={toggleExtraMode}
        onJsonChange={onExtraJsonChange}
        onAddItem={handleExtraItemAdd}
        onRemoveItem={handleExtraItemRemove}
        onUpdateItem={handleExtraItemUpdate}
      />

      <AdvancedSettingsCard
        useFunctionApplyPatch={draft.useFunctionApplyPatch ?? true}
        forceAgent={draft.forceAgent ?? false}
        onToggleUseFunctionApplyPatch={handleUseFunctionApplyPatchToggle}
        onToggleForceAgent={handleForceAgentToggle}
      />
    </div>
  )
}
