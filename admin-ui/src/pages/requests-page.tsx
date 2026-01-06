import { useCallback, useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminRequestItem,
  queryAdminRequests,
} from "@/lib/admin-api"
import { fmtLocalDateTime, fmtNum } from "@/lib/format"
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
import { BorderBeam } from "@/components/ui/border-beam"
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
import { RainbowButton } from "@/components/ui/rainbow-button"
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

function validateTimeRange(fromMs: string, toMs: string): string | null {
  const from = parseMs(fromMs)
  const to = parseMs(toMs)

  if (fromMs.trim() && from == null) return "from_ms must be a number (milliseconds)"
  if (toMs.trim() && to == null) return "to_ms must be a number (milliseconds)"

  if (from != null && to != null && from > to) return "from_ms must be <= to_ms"

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

function TableSkeleton({ rows }: { rows: number }): React.JSX.Element {
  const cols = 10
  const hiddenByCol: Array<string | null> = [
    null,
    null,
    "hidden md:table-cell",
    "hidden md:table-cell",
    "hidden lg:table-cell",
    "hidden xl:table-cell",
    "hidden xl:table-cell",
    "hidden 2xl:table-cell",
    "hidden lg:table-cell",
    null,
  ]

  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <TableCell key={j} className={`py-3 ${hiddenByCol[j] ?? ""}`}>
              <Skeleton className={j === 1 ? "h-4 w-56" : "h-4 w-24"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export function RequestsPage(): React.JSX.Element {
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
    return validateTimeRange(filters.from_ms, filters.to_ms)
  }, [filters.from_ms, filters.to_ms])

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
        toast.error("Failed to load requests", { description: msg })

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

  const colSpan = 10
  const hasQuery = searchParams.toString().length > 0

  return (
    <div className="space-y-4">
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle>Requests</CardTitle>
          <CardDescription className="hidden sm:block">
            Filter and inspect recent requests.
          </CardDescription>
          <CardAction className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={clearAll}
              disabled={!hasQuery || loading}
            >
              Clear
            </Button>
            <RainbowButton onClick={apply} disabled={!canApply} size="sm">
              Apply
            </RainbowButton>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          <Tabs defaultValue="quick" className="gap-1.5">
            <TabsList className="h-8 p-[2px]">
              <TabsTrigger value="quick">Quick</TabsTrigger>
              <TabsTrigger value="advanced">Advanced</TabsTrigger>
            </TabsList>

            <TabsContent value="quick">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                <div className="grid gap-1.5">
                  <Label htmlFor="account_id" className="text-muted-foreground lg:text-xs">
                    Account
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
                  <Label className="text-muted-foreground lg:text-xs">Time range</Label>
                  <Select value={timeRange} onValueChange={(v) => onTimeRangeChange(v as TimeRange)}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__any__">(any)</SelectItem>
                      <SelectItem value="15m">Last 15m</SelectItem>
                      <SelectItem value="1h">Last 1h</SelectItem>
                      <SelectItem value="6h">Last 6h</SelectItem>
                      <SelectItem value="24h">Last 24h</SelectItem>
                      <SelectItem value="7d">Last 7d</SelectItem>
                      <SelectItem value="custom">Custom...</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-1.5">
                  <Label htmlFor="status" className="text-muted-foreground lg:text-xs">
                    Status
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
                  <Label className="text-muted-foreground lg:text-xs">Has error</Label>
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
                      <SelectItem value="__any__">(any)</SelectItem>
                      <SelectItem value="1">yes</SelectItem>
                      <SelectItem value="0">no</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {timeRange === "custom" ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="from_dt" className="text-muted-foreground lg:text-xs">
                        From
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
                        To
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
                    Upstream model
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
                    Client model
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
                    Endpoint
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
                    Path
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
              title="Invalid time range"
              description={validationError}
            />
          ) : null}

        </CardContent>
      </Card>

      <div className="relative">
        {/* subtle highlight for the table container */}
        <BorderBeam className="opacity-30" borderWidth={1} />
        <Card className="relative gap-4 py-4">
          <CardContent className="space-y-4 px-4">
            {error && items.length > 0 ? (
              <InlineAlert
                variant="error"
                title="Failed to load requests"
                description={error}
                actionLabel="Retry"
                onAction={() => void load({ reset: true, cursor: null })}
              />
            ) : null}

            <Table className="[&_th]:h-9 [&_td]:py-1.5">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="hidden md:table-cell">Endpoint</TableHead>
                  <TableHead className="hidden md:table-cell">Account</TableHead>
                  <TableHead className="hidden lg:table-cell">Model</TableHead>
                  <TableHead className="hidden xl:table-cell">Tokens</TableHead>
                  <TableHead className="hidden xl:table-cell">Cost</TableHead>
                  <TableHead className="hidden 2xl:table-cell">Quota</TableHead>
                  <TableHead className="hidden lg:table-cell">Dur</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {error && !loading && items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={colSpan}>
                      <InlineAlert
                        variant="error"
                        title="Failed to load requests"
                        description={error}
                        actionLabel="Retry"
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
                        title="No requests"
                        description={
                          hasQuery
                            ? "No results for the current filters."
                            : "No requests found."
                        }
                        actionLabel={hasQuery ? "Clear filters" : undefined}
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
                      <Badge variant="destructive">{r.http_status}</Badge>
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
                        <TableCell className="hidden md:table-cell font-mono text-xs whitespace-normal break-words">
                          {r.upstream_endpoint || ""}
                        </TableCell>
                        <TableCell className="hidden md:table-cell font-mono text-xs whitespace-normal break-words">
                          {r.account_id || ""}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell font-mono text-xs">
                          {r.upstream_model || ""}
                        </TableCell>
                        <TableCell className="hidden xl:table-cell font-mono text-xs">
                          {r.tokens_total != null ? fmtNum(r.tokens_total) : ""}
                        </TableCell>
                        <TableCell className="hidden xl:table-cell font-mono text-xs">
                          {r.cost_units ?? ""}
                        </TableCell>
                        <TableCell className="hidden 2xl:table-cell font-mono text-xs">{quota}</TableCell>
                        <TableCell className="hidden lg:table-cell font-mono text-xs">
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
              <RainbowButton
                onClick={() => void load({ reset: false, cursor: nextCursor })}
                disabled={loading || !hasMore}
                size="sm"
              >
                {loading && hasMore ? "Loading..." : hasMore ? "Load more" : "No more"}
              </RainbowButton>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
