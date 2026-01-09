import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminAccountItem,
  getAdminAccounts,
  getAdminMeta,
} from "@/lib/admin-api"
import { fmtLocalDateTime, fmtNum } from "@/lib/format"
import { cn } from "@/lib/utils"
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion"
import { Badge } from "@/components/ui/badge"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { Progress } from "@/components/ui/progress"
import { BentoGrid } from "@/components/ui/bento-grid"
import { MagicCard } from "@/components/ui/magic-card"
import { NumberTicker } from "@/components/ui/number-ticker"
import { RainbowButton } from "@/components/ui/rainbow-button"

type WindowPreset = "86400000" | "604800000"

type SortBy = "account" | "requests" | "errors" | "tokens" | "last_req"

function sum(items: Array<number | undefined>): number {
  return items.reduce<number>((acc, x) => acc + (x ?? 0), 0)
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function fmtNumOrDash(n?: number | null): string {
  const s = fmtNum(n)
  return s || "—"
}

function calcWeightedAvgDurationMs(accounts: AdminAccountItem[]): number {
  let totalReq = 0
  let weighted = 0

  for (const a of accounts) {
    const req = a.stats?.request_count ?? 0
    const avg = a.stats?.avg_duration_ms ?? 0
    if (req > 0 && avg > 0) {
      totalReq += req
      weighted += req * avg
    }
  }

  return totalReq > 0 ? Math.round(weighted / totalReq) : 0
}

function KpiValue({
  value,
  decimalPlaces = 0,
}: {
  value: number
  decimalPlaces?: number
}): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()

  if (reducedMotion) {
    return (
      <span className="tabular-nums">
        {Intl.NumberFormat("en-US", {
          minimumFractionDigits: decimalPlaces,
          maximumFractionDigits: decimalPlaces,
        }).format(value)}
      </span>
    )
  }

  return <NumberTicker value={value} decimalPlaces={decimalPlaces} />
}

const accountsTableColVisibility = [
  null,
  null,
  "hidden lg:table-cell",
  null,
  null,
  "hidden xl:table-cell",
  "hidden xl:table-cell",
  "hidden lg:table-cell",
] as const

function AccountsTableSkeleton({ rows }: { rows: number }): React.JSX.Element {
  const cols = accountsTableColVisibility.length

  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <TableCell key={j} className={cn("py-3", accountsTableColVisibility[j])}>
              <Skeleton className={j === 0 ? "h-4 w-56" : "h-4 w-24"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

export function AccountsPage(): React.JSX.Element {
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("86400000")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortBy>("requests")

  const [accounts, setAccounts] = useState<AdminAccountItem[]>([])
  const [meta, setMeta] = useState<{ userVersion?: number; dbPath?: string } | null>(
    null
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const windowMs = Number(windowPreset)
      const sinceMs = Date.now() - windowMs

      const [accRes, metaRes] = await Promise.all([
        getAdminAccounts({ sinceMs, includeStats: true }),
        getAdminMeta(),
      ])

      setAccounts(accRes.items)
      setMeta(metaRes)
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error("Failed to load accounts", { description: msg })
    } finally {
      setLoading(false)
    }
  }, [windowPreset])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const kpis = useMemo(() => {
    const totalAccounts = accounts.length
    const failedAccounts = accounts.filter((a) => a.runtime?.failed).length

    const totalRequests = sum(accounts.map((a) => a.stats?.request_count))
    const totalErrors = sum(accounts.map((a) => a.stats?.error_count))
    const totalTokens = sum(accounts.map((a) => a.stats?.tokens_total))
    const avgDurationMs = calcWeightedAvgDurationMs(accounts)

    const errorRatePct = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0
    const tokensPerRequest = totalRequests > 0 ? totalTokens / totalRequests : 0

    return {
      totalAccounts,
      failedAccounts,
      totalRequests,
      totalErrors,
      totalTokens,
      avgDurationMs,
      errorRatePct,
      tokensPerRequest,
    }
  }, [accounts])

  const visibleAccounts = useMemo(() => {
    const q = query.trim().toLowerCase()

    const filtered = q
      ? accounts.filter((a) => a.account_id.toLowerCase().includes(q))
      : accounts

    const out = [...filtered]

    out.sort((a, b) => {
      if (sortBy === "account") return a.account_id.localeCompare(b.account_id)

      if (sortBy === "last_req") {
        return (b.stats?.last_request_at_ms ?? 0) - (a.stats?.last_request_at_ms ?? 0)
      }

      if (sortBy === "errors") {
        return (b.stats?.error_count ?? 0) - (a.stats?.error_count ?? 0)
      }

      if (sortBy === "tokens") {
        return (b.stats?.tokens_total ?? 0) - (a.stats?.tokens_total ?? 0)
      }

      // default: requests
      return (b.stats?.request_count ?? 0) - (a.stats?.request_count ?? 0)
    })

    return out
  }, [accounts, query, sortBy])

  const windowMs = Number(windowPreset)
  const nowMs = Date.now()
  const fromMs = String(nowMs - windowMs)
  const toMs = String(nowMs)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Stats window</span>
          <Select value={windowPreset} onValueChange={(v) => setWindowPreset(v as WindowPreset)}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="86400000">Last 24h</SelectItem>
              <SelectItem value="604800000">Last 7d</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <RainbowButton onClick={refresh} disabled={loading} size="sm">
          {loading ? "Refreshing..." : "Refresh"}
        </RainbowButton>

        <div className="text-muted-foreground ml-auto text-sm">
          {meta?.dbPath ? `DB v${meta.userVersion ?? "?"} · ${meta.dbPath}` : null}
        </div>
      </div>

      {error ? (
        <InlineAlert
          variant="error"
          title="Failed to load accounts"
          description={error}
          actionLabel="Retry"
          onAction={() => void refresh()}
        />
      ) : null}

      <BentoGrid className="auto-rows-min grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">
        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Accounts</div>
            <div className="mt-1 text-2xl font-semibold">
              <KpiValue value={kpis.totalAccounts} />
            </div>
          </div>
        </MagicCard>

        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Failed</div>
            <div className="mt-1 text-2xl font-semibold">
              <KpiValue value={kpis.failedAccounts} />
            </div>
          </div>
        </MagicCard>

        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Requests</div>
            <div className="mt-1 text-2xl font-semibold">
              <KpiValue value={kpis.totalRequests} />
            </div>
          </div>
        </MagicCard>

        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Errors</div>
            <div className="mt-1 text-2xl font-semibold">
              <KpiValue value={kpis.totalErrors} />
            </div>
          </div>
        </MagicCard>

        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Error rate</div>
            <div className="mt-1 flex items-baseline gap-1 text-2xl font-semibold">
              <KpiValue value={kpis.errorRatePct} decimalPlaces={1} />
              <span className="text-muted-foreground text-sm">%</span>
            </div>
          </div>
        </MagicCard>

        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Tokens / req</div>
            <div className="mt-1 text-2xl font-semibold">
              <KpiValue value={kpis.tokensPerRequest} decimalPlaces={1} />
            </div>
          </div>
        </MagicCard>

        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Tokens</div>
            <div className="mt-1 text-2xl font-semibold">
              <KpiValue value={kpis.totalTokens} />
            </div>
          </div>
        </MagicCard>

        <MagicCard className="rounded-xl">
          <div className="p-4">
            <div className="text-muted-foreground text-xs">Avg duration (ms)</div>
            <div className="mt-1 text-2xl font-semibold">
              <KpiValue value={kpis.avgDurationMs} />
            </div>
          </div>
        </MagicCard>
      </BentoGrid>

      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle>Accounts</CardTitle>
          <CardDescription className="hidden sm:block">
            Click an account to filter requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Input
              placeholder="Filter account"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 sm:max-w-xs"
            />

            <div className="flex items-center gap-2">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="requests">Requests</SelectItem>
                  <SelectItem value="errors">Errors</SelectItem>
                  <SelectItem value="tokens">Tokens</SelectItem>
                  <SelectItem value="last_req">Last req</SelectItem>
                  <SelectItem value="account">Account</SelectItem>
                </SelectContent>
              </Select>

              <div className="text-muted-foreground text-sm tabular-nums">
                {visibleAccounts.length}/{accounts.length}
              </div>
            </div>
          </div>

          <Table className="[&_th]:h-9 [&_td]:py-1.5">
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className={cn(accountsTableColVisibility[2])}>Remaining</TableHead>
                <TableHead>Requests</TableHead>
                <TableHead>Errors</TableHead>
                <TableHead className={cn(accountsTableColVisibility[5])}>Tokens</TableHead>
                <TableHead className={cn(accountsTableColVisibility[6])}>Avg ms</TableHead>
                <TableHead className={cn(accountsTableColVisibility[7])}>Last req</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && accounts.length === 0 ? (
                <AccountsTableSkeleton rows={6} />
              ) : visibleAccounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={accountsTableColVisibility.length}>
                    <InlineAlert
                      variant="info"
                      title={accounts.length === 0 ? "No accounts" : "No matches"}
                      description={
                        accounts.length === 0
                          ? "No accounts found."
                          : "No accounts match the current filter."
                      }
                      actionLabel={query.trim() ? "Clear filter" : undefined}
                      onAction={query.trim() ? () => setQuery("") : undefined}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                visibleAccounts.map((a) => {
                  const failed = a.runtime?.failed
                  const statusBadge = failed ? (
                    <Badge variant="destructive">failed</Badge>
                  ) : (
                    <Badge variant="secondary">ok</Badge>
                  )

                  const total = a.runtime?.entitlement
                  const remainingQuota = a.runtime?.remaining
                  const usedQuota =
                    total != null && remainingQuota != null ?
                      total - remainingQuota
                    : undefined

                  const percentUsedRaw =
                    total != null && total > 0 && usedQuota != null ?
                      (usedQuota / total) * 100
                    : undefined

                  const percentUsed =
                    percentUsedRaw != null && Number.isFinite(percentUsedRaw) ?
                      clampPercent(percentUsedRaw)
                    : undefined

                  const remainingCell = a.runtime?.unlimited ? (
                    <Badge variant="secondary">unlimited</Badge>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <div className="text-xs">
                        <span className="text-muted-foreground">Used:</span>{" "}
                        <span className="tabular-nums">{fmtNumOrDash(usedQuota)}</span>
                      </div>
                      <div className="text-xs">
                        <span className="text-muted-foreground">Remaining:</span>{" "}
                        <span className="tabular-nums">
                          {fmtNumOrDash(remainingQuota)}
                        </span>
                      </div>
                      {percentUsed != null ? (
                        <Progress
                          value={percentUsed}
                          className="h-1.5"
                          aria-label="Premium interactions quota used"
                        />
                      ) : null}
                    </div>
                  )

                  const last = a.stats?.last_request_at_ms
                    ? fmtLocalDateTime(a.stats.last_request_at_ms)
                    : ""

                  return (
                    <TableRow key={a.account_id}>
                      <TableCell className="font-mono">
                        <Link
                          to={`/requests?account_id=${encodeURIComponent(a.account_id)}&from_ms=${fromMs}&to_ms=${toMs}`}
                          className="underline decoration-border hover:decoration-foreground"
                        >
                          {a.account_id}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div>{statusBadge}</div>
                          {failed && a.runtime?.failureReason ? (
                            <div className="text-muted-foreground text-xs">
                              {a.runtime.failureReason}
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell
                        className={cn(accountsTableColVisibility[2], "whitespace-normal")}
                      >
                        {remainingCell}
                      </TableCell>
                      <TableCell>{fmtNum(a.stats?.request_count)}</TableCell>
                      <TableCell>{fmtNum(a.stats?.error_count)}</TableCell>
                      <TableCell className={cn(accountsTableColVisibility[5])}>
                        {fmtNum(a.stats?.tokens_total)}
                      </TableCell>
                      <TableCell className={cn(accountsTableColVisibility[6])}>
                        {a.stats?.avg_duration_ms != null
                          ? fmtNum(Math.round(a.stats.avg_duration_ms))
                          : ""}
                      </TableCell>
                      <TableCell className={cn(accountsTableColVisibility[7], "font-mono text-xs")}>
                        {last}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
