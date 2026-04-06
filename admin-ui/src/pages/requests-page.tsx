import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { LoaderCircleIcon } from "lucide-react"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"

import {
  AdminApiError,
  type AdminRequestItem,
  queryAdminRequests,
} from "@/lib/admin-api"
import { fmtLocalDateTime, fmtNum } from "@/lib/format"
import { i18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type Filters = {
  account_id: string
  upstream_model: string
  client_model: string
  upstream_endpoint: string
  path: string
  status: string
  has_error: string
  from_ms: string
  to_ms: string
}

type TimeRange = "__any__" | "15m" | "1h" | "6h" | "24h" | "7d" | "custom"

function getFiltersFromSearch(p: URLSearchParams): Filters {
  return {
    account_id: p.get("account_id") || "",
    upstream_model: p.get("upstream_model") || "",
    client_model: p.get("client_model") || "",
    upstream_endpoint: p.get("upstream_endpoint") || "",
    path: p.get("path") || "",
    status: p.get("status") || "",
    has_error: p.get("has_error") || "",
    from_ms: p.get("from_ms") || "",
    to_ms: p.get("to_ms") || "",
  }
}

function buildSearchFromFilters(f: Filters): URLSearchParams {
  const out = new URLSearchParams()
  ;(
    [
      ["account_id", f.account_id],
      ["upstream_model", f.upstream_model],
      ["client_model", f.client_model],
      ["upstream_endpoint", f.upstream_endpoint],
      ["path", f.path],
      ["status", f.status],
      ["has_error", f.has_error],
      ["from_ms", f.from_ms],
      ["to_ms", f.to_ms],
    ] as const
  ).forEach(([k, v]) => {
    const trimmed = v.trim()
    if (trimmed) out.set(k, trimmed)
  })
  return out
}

function parseMs(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const num = Number(trimmed)
  if (!Number.isFinite(num)) return null

  const int = Math.trunc(num)
  if (int < 0) return null

  return int
}

type TimeRangeValidationErrorKey =
  | "requestsPage.validation.fromMsMustBeNumber"
  | "requestsPage.validation.toMsMustBeNumber"
  | "requestsPage.validation.fromMsMustBeLteToMs"

function validateTimeRange(
  fromMs: string,
  toMs: string
): TimeRangeValidationErrorKey | null {
  const from = parseMs(fromMs)
  const to = parseMs(toMs)

  if (fromMs.trim() && from === null) return "requestsPage.validation.fromMsMustBeNumber"
  if (toMs.trim() && to === null) return "requestsPage.validation.toMsMustBeNumber"

  if (from !== null && to !== null && from > to) {
    return "requestsPage.validation.fromMsMustBeLteToMs"
  }

  return null
}

function localInputToMs(value: string): string {
  if (!value) return ""
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return ""
  return String(ms)
}

function msToLocalInput(ms: string): string {
  const n = Number(ms)
  if (!Number.isFinite(n)) return ""
  const d = new Date(n)

  const pad2 = (x: number) => String(x).padStart(2, "0")
  const yyyy = d.getFullYear()
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const min = pad2(d.getMinutes())

  return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

function presetToRange(preset: Exclude<TimeRange, "__any__" | "custom">): {
  from_ms: string
  to_ms: string
} {
  const now = Date.now()

  const windowMsByPreset: Record<Exclude<TimeRange, "__any__" | "custom">, number> = {
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  }

  const windowMs = windowMsByPreset[preset]

  return { from_ms: String(now - windowMs), to_ms: String(now) }
}

const requestsTableColVisibility = [
  null,
  null,
  "hidden md:table-cell",
  "hidden md:table-cell",
  "hidden lg:table-cell",
  "hidden lg:table-cell",
  "hidden xl:table-cell",
  "hidden xl:table-cell",
  "hidden 2xl:table-cell",
  "hidden lg:table-cell",
  null,
] as const

/** Table column header with optional tooltip. */
function ColHead({ label, tooltip }: { label: string; tooltip?: string }): React.JSX.Element {
  if (!tooltip) return <>{label}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dashed decoration-current/30 underline-offset-2">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-60">
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function TableSkeleton({ rows }: { rows: number }): React.JSX.Element {
  const cols = requestsTableColVisibility.length

  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <TableCell key={j} className={cn("py-3", requestsTableColVisibility[j])}>
              <Skeleton className={j === 1 ? "h-4 w-56" : "h-4 w-24"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export function RequestsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()

  const [filters, setFilters] = useState<Filters>(() =>
    getFiltersFromSearch(searchParams)
  )

  const [items, setItems] = useState<AdminRequestItem[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeFilters = useMemo(() => getFiltersFromSearch(searchParams), [searchParams])

  const [timeRange, setTimeRange] = useState<TimeRange>(() => {
    const initial = getFiltersFromSearch(searchParams)
    return initial.from_ms || initial.to_ms ? "custom" : "__any__"
  })

  useEffect(() => {
    setFilters(activeFilters)

    const hasRange = Boolean(activeFilters.from_ms || activeFilters.to_ms)
    setTimeRange((prev) => {
      if (!hasRange) return "__any__"
      return prev === "__any__" ? "custom" : prev
    })
  }, [activeFilters])

  const validationError = useMemo(() => {
    const key = validateTimeRange(filters.from_ms, filters.to_ms)
    return key ? t(key) : null
  }, [filters.from_ms, filters.to_ms, t])

  const load = useCallback(
    async ({
      reset,
      cursor,
    }: {
      reset: boolean
      cursor: number | null
    }): Promise<void> => {
      setLoading(true)
      setError(null)

      try {
        const data = await queryAdminRequests({
          ...activeFilters,
          limit: 50,
          cursor_id: reset ? null : cursor,
        })

        setItems((prev) => (reset ? data.items : prev.concat(data.items)))
        setNextCursor(data.next_cursor_id ?? null)
        setHasMore(Boolean(data.has_more))
      } catch (err) {
        const msg = err instanceof AdminApiError ? err.message : String(err)
        setError(msg)
        toast.error(i18n.t("requestsPage.loadFailedTitle"), { description: msg })

        if (reset) setItems([])
        setHasMore(false)
        setNextCursor(null)
      } finally {
        setLoading(false)
      }
    },
    [activeFilters]
  )

  // Reload when filters in URL change.
  useEffect(() => {
    void load({ reset: true, cursor: null })
  }, [load])

  function apply(): void {
    if (validationError) return
    setSearchParams(buildSearchFromFilters(filters))
  }

  function clearAll(): void {
    setSearchParams(new URLSearchParams())
  }

  function onTimeRangeChange(value: TimeRange): void {
    setTimeRange(value)

    if (value === "__any__") {
      setFilters((p) => ({ ...p, from_ms: "", to_ms: "" }))
      return
    }

    if (value === "custom") {
      return
    }

    const { from_ms, to_ms } = presetToRange(value)
    setFilters((p) => ({ ...p, from_ms, to_ms }))
  }

  const fromLocal = useMemo(() => {
    return timeRange === "custom" ? msToLocalInput(filters.from_ms) : ""
  }, [filters.from_ms, timeRange])

  const toLocal = useMemo(() => {
    return timeRange === "custom" ? msToLocalInput(filters.to_ms) : ""
  }, [filters.to_ms, timeRange])

  const canApply = !loading && !validationError

  const colSpan = requestsTableColVisibility.length
  const hasQuery = searchParams.toString().length > 0

  const activeFilterCount = useMemo(() => {
    let count = 0
    for (const [, v] of searchParams) {
      if (v.trim()) count++
    }
    return count
  }, [searchParams])

  // --- Auto-refresh ---
  const [autoRefreshMs, setAutoRefreshMs] = useState<number>(0)
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current)
      autoRefreshRef.current = null
    }
    if (autoRefreshMs > 0) {
      autoRefreshRef.current = setInterval(() => {
        void load({ reset: true, cursor: null })
      }, autoRefreshMs)
    }
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    }
  }, [autoRefreshMs, load])

  // --- Enter to apply filters ---
  const applyRef = useRef(apply)
  applyRef.current = apply

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter") return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "TEXTAREA") return
      if ((e.target as HTMLElement)?.closest("[role=dialog]")) return
      if ((e.target as HTMLElement)?.closest("[role=listbox]")) return
      e.preventDefault()
      applyRef.current()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [])

  let loadMoreLabel = t("common.noMore")
  if (hasMore) {
    loadMoreLabel = loading ? t("common.loading") : t("common.loadMore")
  }

  return (
    <div className="space-y-4">
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t("nav.requests")}</CardTitle>
          <CardDescription className="hidden sm:block">{t("requestsPage.description")}</CardDescription>
          <CardAction className="flex items-center gap-2">
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="text-xs">
                {t("requestsPage.activeFilters", { count: activeFilterCount })}
              </Badge>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearAll}
              disabled={!hasQuery || loading}
            >
              {t("common.clear")}
            </Button>
            <Button onClick={apply} disabled={!canApply} size="sm">
              {loading && <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />}
              {t("common.apply")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          <Tabs defaultValue="quick" className="gap-1.5">
            <TabsList className="h-8 p-[2px]">
              <TabsTrigger value="quick">{t("requestsPage.tabs.quick")}</TabsTrigger>
              <TabsTrigger value="advanced">{t("requestsPage.tabs.advanced")}</TabsTrigger>
            </TabsList>

            <TabsContent value="quick">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                <div className="grid gap-1.5">
                  <Label htmlFor="account_id" className="text-muted-foreground lg:text-xs">
                    {t("common.account")}
                  </Label>
                  <Input
                    id="account_id"
                    className="h-8"
                    placeholder="octocat"
                    value={filters.account_id}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, account_id: e.target.value }))
                    }
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground lg:text-xs">{t("requestsPage.filters.timeRange")}</Label>
                  <Select value={timeRange} onValueChange={(v) => onTimeRangeChange(v as TimeRange)}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">{t("common.any")}</SelectItem>
                      <SelectItem value="15m">{t("requestsPage.timeRange.last15m")}</SelectItem>
                      <SelectItem value="1h">{t("requestsPage.timeRange.last1h")}</SelectItem>
                      <SelectItem value="6h">{t("requestsPage.timeRange.last6h")}</SelectItem>
                      <SelectItem value="24h">{t("requestsPage.timeRange.last24h")}</SelectItem>
                      <SelectItem value="7d">{t("requestsPage.timeRange.last7d")}</SelectItem>
                      <SelectItem value="custom">{t("requestsPage.timeRange.custom")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="status" className="text-muted-foreground lg:text-xs">
                    {t("common.status")}
                  </Label>
                  <Input
                    id="status"
                    className="h-8"
                    placeholder="200"
                    value={filters.status}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, status: e.target.value }))
                    }
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label className="text-muted-foreground lg:text-xs">{t("requestsPage.filters.hasError")}</Label>
                  <Select
                    value={filters.has_error || "__any__"}
                    onValueChange={(v) =>
                      setFilters((p) => ({
                        ...p,
                        has_error: v === "__any__" ? "" : v,
                      }))
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">{t("common.any")}</SelectItem>
                      <SelectItem value="1">{t("common.yes")}</SelectItem>
                      <SelectItem value="0">{t("common.no")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {timeRange === "custom" ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="from_dt" className="text-muted-foreground lg:text-xs">
                        {t("common.from")}
                      </Label>
                      <Input
                        id="from_dt"
                        className="h-8"
                        type="datetime-local"
                        value={fromLocal}
                        onChange={(e) => {
                          setTimeRange("custom")
                          setFilters((p) => ({
                            ...p,
                            from_ms: localInputToMs(e.target.value),
                          }))
                        }}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="to_dt" className="text-muted-foreground lg:text-xs">
                        {t("common.to")}
                      </Label>
                      <Input
                        id="to_dt"
                        className="h-8"
                        type="datetime-local"
                        value={toLocal}
                        onChange={(e) => {
                          setTimeRange("custom")
                          setFilters((p) => ({
                            ...p,
                            to_ms: localInputToMs(e.target.value),
                          }))
                        }}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </TabsContent>

            <TabsContent value="advanced">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="upstream_model" className="text-muted-foreground lg:text-xs">
                    {t("requestsPage.filters.upstreamModel")}
                  </Label>
                  <Input
                    id="upstream_model"
                    className="h-8"
                    placeholder="gpt-5"
                    value={filters.upstream_model}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, upstream_model: e.target.value }))
                    }
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="client_model" className="text-muted-foreground lg:text-xs">
                    {t("requestsPage.filters.clientModel")}
                  </Label>
                  <Input
                    id="client_model"
                    className="h-8"
                    placeholder="claude-sonnet-4"
                    value={filters.client_model}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, client_model: e.target.value }))
                    }
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label
                    htmlFor="upstream_endpoint"
                    className="text-muted-foreground lg:text-xs"
                  >
                    {t("common.endpoint")}
                  </Label>
                  <Input
                    id="upstream_endpoint"
                    className="h-8"
                    placeholder="/responses"
                    value={filters.upstream_endpoint}
                    onChange={(e) =>
                      setFilters((p) => ({
                        ...p,
                        upstream_endpoint: e.target.value,
                      }))
                    }
                  />
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="path" className="text-muted-foreground lg:text-xs">
                    {t("common.path")}
                  </Label>
                  <Input
                    id="path"
                    className="h-8"
                    placeholder="/v1/messages"
                    value={filters.path}
                    onChange={(e) =>
                      setFilters((p) => ({ ...p, path: e.target.value }))
                    }
                  />
                </div>

              </div>
            </TabsContent>
          </Tabs>

          {validationError ? (
            <InlineAlert
              variant="warning"
              title={t("requestsPage.validation.title")}
              description={validationError}
            />
          ) : null}

        </CardContent>
      </Card>

      <div className="flex items-center justify-between motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
        <span className="text-muted-foreground text-sm">
          {items.length > 0
            ? hasMore
              ? t("requestsPage.resultCountWithMore", { count: items.length })
              : t("requestsPage.resultCount", { count: items.length })
            : null}
        </span>
        <div className="flex items-center gap-2">
          {autoRefreshMs > 0 && (
            <span className="relative flex h-2 w-2">
              <span className="bg-primary absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full opacity-75" />
              <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
            </span>
          )}
          <span className="text-muted-foreground text-sm">{t("requestsPage.autoRefreshLabel")}</span>
          <Select value={String(autoRefreshMs)} onValueChange={(v) => setAutoRefreshMs(Number(v))}>
            <SelectTrigger size="sm" className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="0">{t("requestsPage.autoRefresh.off")}</SelectItem>
              <SelectItem value="30000">{t("requestsPage.autoRefresh.30s")}</SelectItem>
              <SelectItem value="60000">{t("requestsPage.autoRefresh.60s")}</SelectItem>
              <SelectItem value="300000">{t("requestsPage.autoRefresh.5m")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="gap-4 py-4">
          <CardContent className="space-y-4 px-4">
            {error && items.length > 0 ? (
              <InlineAlert
                variant="error"
                title={t("requestsPage.loadFailedTitle")}
                description={error}
                actionLabel={t("common.retry")}
                onAction={() => void load({ reset: true, cursor: null })}
              />
            ) : null}

            <Table className="[&_th]:h-9 [&_td]:py-1.5">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("common.time")}</TableHead>
                  <TableHead>{t("common.path")}</TableHead>
                  <TableHead className={cn(requestsTableColVisibility[2])}>
                    {t("common.endpoint")}
                  </TableHead>
                  <TableHead className={cn(requestsTableColVisibility[3])}>
                    {t("common.account")}
                  </TableHead>
                  <TableHead className={cn(requestsTableColVisibility[4])}>
                    {t("common.model")}
                  </TableHead>
                  <TableHead className={cn(requestsTableColVisibility[5])}>
                    <ColHead label={t("common.xInitiator")} tooltip={t("requestsPage.columnTooltip.initiator")} />
                  </TableHead>
                  <TableHead className={cn(requestsTableColVisibility[6])}>
                    <ColHead label={t("common.tokens")} tooltip={t("requestsPage.columnTooltip.tokens")} />
                  </TableHead>
                  <TableHead className={cn(requestsTableColVisibility[7])}>
                    <ColHead label={t("common.cost")} tooltip={t("requestsPage.columnTooltip.cost")} />
                  </TableHead>
                  <TableHead className={cn(requestsTableColVisibility[8])}>
                    <ColHead label={t("common.quota")} tooltip={t("requestsPage.columnTooltip.quota")} />
                  </TableHead>
                  <TableHead className={cn(requestsTableColVisibility[9])}>
                    <ColHead label={t("common.durationAbbrev")} tooltip={t("requestsPage.columnTooltip.duration")} />
                  </TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {error && !loading && items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={colSpan}>
                      <InlineAlert
                        variant="error"
                        title={t("requestsPage.loadFailedTitle")}
                        description={error}
                        actionLabel={t("common.retry")}
                        onAction={() => void load({ reset: true, cursor: null })}
                      />
                    </TableCell>
                  </TableRow>
                ) : loading && items.length === 0 ? (
                  <TableSkeleton rows={6} />
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={colSpan}>
                      <InlineAlert
                        variant="info"
                        title={t("requestsPage.empty.noRequestsTitle")}
                        description={
                          hasQuery
                            ? t("requestsPage.empty.noResultsForFilters")
                            : t("requestsPage.empty.noRequestsFound")
                        }
                        actionLabel={hasQuery ? t("common.clearFilters") : undefined}
                        onAction={hasQuery ? clearAll : undefined}
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((r) => {
                    const quota = r.premium_unlimited_after
                      ? "∞"
                      : r.premium_remaining_after != null
                        ? fmtNum(r.premium_remaining_after)
                        : ""

                    const statusBadge = r.http_status >= 400 ? (
                      <Badge variant="destructive" aria-label={`Error ${r.http_status}`}>
                        <span aria-hidden="true" className="mr-0.5">!</span>{r.http_status}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">{r.http_status}</Badge>
                    )

                    return (
                      <TableRow key={r.request_id}>
                        <TableCell className="font-mono text-xs">
                          {fmtLocalDateTime(r.started_at_ms)}
                        </TableCell>
                        <TableCell className="font-mono whitespace-normal break-words">
                          <Link
                            to={`/request/${encodeURIComponent(r.request_id)}`}
                            state={{ fromSearch: searchParams.toString() }}
                            className="underline decoration-border hover:decoration-foreground"
                          >
                            {r.path}
                          </Link>
                        </TableCell>
                        <TableCell
                          className={cn(
                            requestsTableColVisibility[2],
                            "font-mono text-xs whitespace-normal break-words"
                          )}
                        >
                          {r.upstream_endpoint || ""}
                        </TableCell>
                        <TableCell
                          className={cn(
                            requestsTableColVisibility[3],
                            "font-mono text-xs whitespace-normal break-words"
                          )}
                        >
                          {r.account_id || ""}
                          {r.affinity_hit ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="outline" className="ml-1 px-1 py-0 text-[10px] leading-tight align-middle" aria-label={t("requestsPage.affinityHit")}>
                                  affinity
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>{t("requestsPage.affinityHit")}</p>
                                {r.affinity_cache_key && (
                                  <p className="font-mono text-xs opacity-80">{r.affinity_cache_key}</p>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </TableCell>
                        <TableCell className={cn(requestsTableColVisibility[4], "font-mono text-xs")}>
                          {r.upstream_model || ""}
                        </TableCell>
                        <TableCell className={cn(requestsTableColVisibility[5], "font-mono text-xs")}>
                          {r.initiator || ""}
                        </TableCell>
                        <TableCell className={cn(requestsTableColVisibility[6], "font-mono text-xs")}>
                          {r.tokens_total != null ? fmtNum(r.tokens_total) : ""}
                        </TableCell>
                        <TableCell className={cn(requestsTableColVisibility[7], "font-mono text-xs")}>
                          {r.cost_units ?? ""}
                        </TableCell>
                        <TableCell className={cn(requestsTableColVisibility[8], "font-mono text-xs")}>
                          {quota}
                        </TableCell>
                        <TableCell className={cn(requestsTableColVisibility[9], "font-mono text-xs")}>
                          {r.duration_ms != null ? fmtNum(r.duration_ms) : ""}
                        </TableCell>
                        <TableCell>{statusBadge}</TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>

            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => void load({ reset: false, cursor: nextCursor })}
                disabled={loading || !hasMore}
                size="sm"
              >
                {loading && <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />}
                {loadMoreLabel}
              </Button>
            </div>
          </CardContent>
        </Card>
    </div>
  )
}
