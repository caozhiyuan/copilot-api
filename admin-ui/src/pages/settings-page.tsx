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
  model: string
  prompt: string
}

type ReasoningItem = {
  model: string
  effort: ReasoningEffort
}

type ParseResult<T> = { record: T } | { error: string }

type JsonMode = "form" | "json"

function toggleJsonMode<TRecord>(
  next: boolean,
  record: TRecord | undefined,
  setJson: (value: string) => void,
  setError: (value: string | null) => void,
  setMode: (mode: JsonMode) => void,
): void {
  if (next) {
    setJson(JSON.stringify(record ?? {}, null, 2))
  }
  setError(null)
  setMode(next ? "json" : "form")
}

function updateJsonRecord<TRecord>(
  value: string,
  parse: (value: string) => ParseResult<TRecord>,
  setJson: (value: string) => void,
  setError: (value: string | null) => void,
  onRecord: (record: TRecord) => void,
): void {
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

function extraPromptItemsFromRecord(
  record: Record<string, string> | undefined
): ExtraPromptItem[] {
  if (!record) return []
  return Object.entries(record).map(([model, prompt]) => ({ model, prompt }))
}

function reasoningItemsFromRecord(
  record: Record<string, ReasoningEffort> | undefined
): ReasoningItem[] {
  if (!record) return []
  return Object.entries(record).map(([model, effort]) => ({ model, effort }))
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

export function SettingsPage(): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [configPath, setConfigPath] = useState<string | null>(null)

  const [models, setModels] = useState<string[]>([])
  const [draft, setDraft] = useState<AdminConfig>({})

  const [extraMode, setExtraMode] = useState<JsonMode>("form")
  const [extraItems, setExtraItems] = useState<ExtraPromptItem[]>([])
  const [extraJson, setExtraJson] = useState("")
  const [extraJsonError, setExtraJsonError] = useState<string | null>(null)

  const [reasoningMode, setReasoningMode] = useState<JsonMode>("form")
  const [reasoningItems, setReasoningItems] = useState<ReasoningItem[]>([])
  const [reasoningJson, setReasoningJson] = useState("")
  const [reasoningJsonError, setReasoningJsonError] = useState<string | null>(null)

  const applyConfigResponse = useCallback((config: AdminConfigResponse) => {
    const { _configPath, ...configData } = config
    setConfigPath(_configPath ?? null)
    setDraft(configData)
    setExtraItems(extraPromptItemsFromRecord(configData.extraPrompts))
    setExtraJson(JSON.stringify(configData.extraPrompts ?? {}, null, 2))
    setExtraJsonError(null)
    setReasoningItems(reasoningItemsFromRecord(configData.modelReasoningEfforts))
    setReasoningJson(JSON.stringify(configData.modelReasoningEfforts ?? {}, null, 2))
    setReasoningJsonError(null)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const [configRes, modelsRes] = await Promise.all([getAdminConfig(), getAdminModels()])
      applyConfigResponse(configRes)
      setModels(modelsRes.items ?? [])
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
    && !(extraMode === "json" && extraJsonError)
    && !(reasoningMode === "json" && reasoningJsonError)

  const envOverrideNote =
    "Environment variable COPILOT_API_KEY overrides this value when set."

  const smallModelLabel = hasModels ? "Small model" : "Small model (manual)"

  const extraPromptJsonIssue = useMemo(
    () => (extraJsonError ? `extraPrompts: ${extraJsonError}` : null),
    [extraJsonError]
  )

  const reasoningJsonIssue = useMemo(
    () => (reasoningJsonError ? `modelReasoningEfforts: ${reasoningJsonError}` : null),
    [reasoningJsonError]
  )

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

  function updateExtraItems(nextItems: ExtraPromptItem[]): void {
    setExtraItems(nextItems)
    setDraft((prev) => ({
      ...prev,
      extraPrompts: extraPromptRecordFromItems(nextItems),
    }))
  }

  function updateReasoningItems(nextItems: ReasoningItem[]): void {
    setReasoningItems(nextItems)
    setDraft((prev) => ({
      ...prev,
      modelReasoningEfforts: reasoningRecordFromItems(nextItems),
    }))
  }

  function onExtraJsonChange(value: string): void {
    updateJsonRecord(
      value,
      parseExtraPromptsJson,
      setExtraJson,
      setExtraJsonError,
      (record) => updateExtraItems(extraPromptItemsFromRecord(record)),
    )
  }

  function onReasoningJsonChange(value: string): void {
    updateJsonRecord(
      value,
      parseReasoningJson,
      setReasoningJson,
      setReasoningJsonError,
      (record) => updateReasoningItems(reasoningItemsFromRecord(record)),
    )
  }

  function toggleExtraMode(next: boolean): void {
    toggleJsonMode(
      next,
      draft.extraPrompts,
      setExtraJson,
      setExtraJsonError,
      setExtraMode,
    )
  }

  function toggleReasoningMode(next: boolean): void {
    toggleJsonMode(
      next,
      draft.modelReasoningEfforts,
      setReasoningJson,
      setReasoningJsonError,
      setReasoningMode,
    )
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
              <Select
                value={smallModelValue}
                onValueChange={(value) =>
                  setDraft((prev) => ({
                    ...prev,
                    smallModel: value === "__default__" ? "" : value,
                  }))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select small model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">(default)</SelectItem>
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
                value={draft.smallModel ?? ""}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, smallModel: e.target.value }))
                }
              />
            )}
            <div className="text-muted-foreground text-xs">
              Controls which model receives lightweight/free requests when routing.
            </div>
          </div>

          <div className="grid gap-2">
            <Label className="text-muted-foreground text-xs">API key</Label>
            <Input
              placeholder="sk-..."
              value={draft.apiKey ?? ""}
              onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
            />
            <div className="text-muted-foreground text-xs">
              {envOverrideNote} Leave empty to clear config value.
            </div>
          </div>
        </CardContent>
      </Card>

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
            <Switch
              checked={draft.freeModelLoadBalancing ?? true}
              onCheckedChange={(value) =>
                setDraft((prev) => ({ ...prev, freeModelLoadBalancing: value }))
              }
            />
          </div>
        </CardContent>
      </Card>

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
              <Switch checked={reasoningMode === "json"} onCheckedChange={toggleReasoningMode} />
              <Label className="text-muted-foreground text-xs">JSON mode</Label>
            </div>
          </div>

          {reasoningMode === "json" ? (
            <div className="space-y-2">
              <Textarea
                value={reasoningJson}
                onChange={(e) => onReasoningJsonChange(e.target.value)}
                className="min-h-[160px] font-mono text-xs"
                placeholder='{ "gpt-5-mini": "low" }'
              />
              {reasoningJsonIssue ? (
                <InlineAlert
                  variant="warning"
                  title="Invalid JSON"
                  description={reasoningJsonIssue}
                />
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              {reasoningItems.length === 0 ? (
                <div className="text-muted-foreground text-sm">
                  No reasoning overrides. Add a model below.
                </div>
              ) : (
                reasoningItems.map((item, index) => (
                  <div key={`${item.model}-${index}`} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        placeholder="model id"
                        value={item.model}
                        onChange={(e) => {
                          const next = [...reasoningItems]
                          next[index] = { ...item, model: e.target.value }
                          updateReasoningItems(next)
                        }}
                      />
                      <Select
                        value={item.effort}
                        onValueChange={(value) => {
                          const next = [...reasoningItems]
                          next[index] = { ...item, effort: value as ReasoningEffort }
                          updateReasoningItems(next)
                        }}
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
                        onClick={() => {
                          const next = reasoningItems.filter((_, i) => i !== index)
                          updateReasoningItems(next)
                        }}
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

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  updateReasoningItems(
                    reasoningItems.concat({ model: "", effort: "high" })
                  )
                }
              >
                Add model override
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

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
              <Switch checked={extraMode === "json"} onCheckedChange={toggleExtraMode} />
              <Label className="text-muted-foreground text-xs">JSON mode</Label>
            </div>
          </div>

          {extraMode === "json" ? (
            <div className="space-y-2">
              <Textarea
                value={extraJson}
                onChange={(e) => onExtraJsonChange(e.target.value)}
                className="min-h-[200px] font-mono text-xs"
                placeholder='{ "gpt-5-mini": "..." }'
              />
              {extraPromptJsonIssue ? (
                <InlineAlert
                  variant="warning"
                  title="Invalid JSON"
                  description={extraPromptJsonIssue}
                />
              ) : null}
            </div>
          ) : (
            <div className="space-y-2">
              {extraItems.length === 0 ? (
                <div className="text-muted-foreground text-sm">
                  No extra prompts configured.
                </div>
              ) : (
                extraItems.map((item, index) => (
                  <div key={`${item.model}-${index}`} className="grid gap-2 rounded-lg border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        placeholder="model id"
                        value={item.model}
                        onChange={(e) => {
                          const next = [...extraItems]
                          next[index] = { ...item, model: e.target.value }
                          updateExtraItems(next)
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const next = extraItems.filter((_, i) => i !== index)
                          updateExtraItems(next)
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                    <Textarea
                      value={item.prompt}
                      onChange={(e) => {
                        const next = [...extraItems]
                        next[index] = { ...item, prompt: e.target.value }
                        updateExtraItems(next)
                      }}
                      className="min-h-[120px] font-mono text-xs"
                      placeholder="System prompt snippet..."
                    />
                    <div className="text-muted-foreground text-xs">
                      Adds prompt content before model execution.
                    </div>
                  </div>
                ))
              )}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => updateExtraItems(extraItems.concat({ model: "", prompt: "" }))}
              >
                Add prompt
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

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
            <Switch
              checked={draft.useFunctionApplyPatch ?? true}
              onCheckedChange={(value) =>
                setDraft((prev) => ({ ...prev, useFunctionApplyPatch: value }))
              }
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-medium">Force agent header</div>
              <div className="text-muted-foreground text-xs">
                Forces agent routing logic even when clients omit hints.
              </div>
            </div>
            <Switch
              checked={draft.forceAgent ?? false}
              onCheckedChange={(value) => setDraft((prev) => ({ ...prev, forceAgent: value }))}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
