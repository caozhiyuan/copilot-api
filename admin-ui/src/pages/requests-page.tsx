import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminRequestItem,
  queryAdminRequests,
} from "@/lib/admin-api"
import { fmtIso, fmtNum } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ShimmerButton } from "@/components/ui/shimmer-button"
import { BorderBeam } from "@/components/ui/border-beam"
import { useSearchParams } from "react-router-dom"

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

export function RequestsPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()

  const [filters, setFilters] = useState<Filters>(() =>
    getFiltersFromSearch(searchParams)
  )

  const [items, setItems] = useState<AdminRequestItem[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)

  const activeFilters = useMemo(() => getFiltersFromSearch(searchParams), [searchParams])

  useEffect(() => {
    setFilters(activeFilters)
  }, [activeFilters])

  async function load(reset: boolean): Promise<void> {
    setLoading(true)
    try {
      const data = await queryAdminRequests({
        ...activeFilters,
        limit: 50,
        cursor_id: reset ? null : nextCursor,
      })

      setItems((prev) => (reset ? data.items : prev.concat(data.items)))
      setNextCursor(data.next_cursor_id ?? null)
      setHasMore(Boolean(data.has_more))
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      toast.error("Failed to load requests", { description: msg })
      if (reset) setItems([])
      setHasMore(false)
      setNextCursor(null)
    } finally {
      setLoading(false)
    }
  }

  // Reload when filters in URL change.
  useEffect(() => {
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()])

  function apply(): void {
    setSearchParams(buildSearchFromFilters(filters))
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Requests</CardTitle>
          <CardDescription>Filter and inspect recent requests.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="account_id">Account</Label>
              <Input
                id="account_id"
                placeholder="octocat"
                value={filters.account_id}
                onChange={(e) =>
                  setFilters((p) => ({ ...p, account_id: e.target.value }))
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="upstream_model">Upstream model</Label>
              <Input
                id="upstream_model"
                placeholder="gpt-5"
                value={filters.upstream_model}
                onChange={(e) =>
                  setFilters((p) => ({ ...p, upstream_model: e.target.value }))
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="client_model">Client model</Label>
              <Input
                id="client_model"
                placeholder="claude-sonnet-4"
                value={filters.client_model}
                onChange={(e) =>
                  setFilters((p) => ({ ...p, client_model: e.target.value }))
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="upstream_endpoint">Endpoint</Label>
              <Input
                id="upstream_endpoint"
                placeholder="/responses"
                value={filters.upstream_endpoint}
                onChange={(e) =>
                  setFilters((p) => ({ ...p, upstream_endpoint: e.target.value }))
                }
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="path">Path</Label>
              <Input
                id="path"
                placeholder="/v1/messages"
                value={filters.path}
                onChange={(e) => setFilters((p) => ({ ...p, path: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="status">Status</Label>
              <Input
                id="status"
                placeholder="200"
                value={filters.status}
                onChange={(e) => setFilters((p) => ({ ...p, status: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label>Has error</Label>
              <Select
                value={filters.has_error || "__any__"}
                onValueChange={(v) =>
                  setFilters((p) => ({
                    ...p,
                    has_error: v === "__any__" ? "" : v,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">(any)</SelectItem>
                  <SelectItem value="1">yes</SelectItem>
                  <SelectItem value="0">no</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="from_ms">From (ms)</Label>
              <Input
                id="from_ms"
                placeholder=""
                value={filters.from_ms}
                onChange={(e) => setFilters((p) => ({ ...p, from_ms: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="to_ms">To (ms)</Label>
              <Input
                id="to_ms"
                placeholder=""
                value={filters.to_ms}
                onChange={(e) => setFilters((p) => ({ ...p, to_ms: e.target.value }))}
              />
            </div>

            <div className="flex flex-col justify-end gap-2 md:col-span-2 md:flex-row">
              <ShimmerButton
                onClick={apply}
                disabled={loading}
                background="hsl(var(--primary))"
                className="h-9 px-4"
              >
                Apply
              </ShimmerButton>
              <ShimmerButton
                onClick={() => void load(false)}
                disabled={loading || !hasMore}
                background="hsl(var(--secondary))"
                className="h-9 px-4"
              >
                {hasMore ? "Load more" : "No more"}
              </ShimmerButton>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="relative">
        {/* subtle highlight for the table container */}
        <BorderBeam className="opacity-30" borderWidth={1} />
        <Card className="relative">
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Quota</TableHead>
                  <TableHead>Dur</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && !loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-muted-foreground">
                      No data.
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
                          {fmtIso(r.started_at_ms)}
                        </TableCell>
                        <TableCell className="font-mono">
                          <a
                            href={`#/request/${encodeURIComponent(r.request_id)}`}
                            className="underline decoration-border hover:decoration-foreground"
                          >
                            {r.path}
                          </a>
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.upstream_endpoint || ""}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.account_id || ""}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.upstream_model || ""}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.tokens_total != null ? fmtNum(r.tokens_total) : ""}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.cost_units ?? ""}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{quota}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.duration_ms != null ? fmtNum(r.duration_ms) : ""}
                        </TableCell>
                        <TableCell>{statusBadge}</TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
