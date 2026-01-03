import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminAccountItem,
  getAdminAccounts,
  getAdminMeta,
} from "@/lib/admin-api"
import { fmtIso, fmtNum } from "@/lib/format"
import { usePrefersReducedMotion } from "@/lib/use-prefers-reduced-motion"
import { Badge } from "@/components/ui/badge"
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
import { BentoGrid } from "@/components/ui/bento-grid"
import { MagicCard } from "@/components/ui/magic-card"
import { NumberTicker } from "@/components/ui/number-ticker"
import { ShimmerButton } from "@/components/ui/shimmer-button"

type WindowPreset = "86400000" | "604800000"

function sum(items: Array<number | undefined>): number {
  return items.reduce<number>((acc, x) => acc + (x ?? 0), 0)
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

function KpiValue({ value }: { value: number }): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion()

  if (reducedMotion) {
    return <span className="tabular-nums">{fmtNum(value)}</span>
  }

  return <NumberTicker value={value} />
}

export function AccountsPage(): React.JSX.Element {
  const [windowPreset, setWindowPreset] = useState<WindowPreset>("86400000")
  const [loading, setLoading] = useState(false)
  const [accounts, setAccounts] = useState<AdminAccountItem[]>([])
  const [meta, setMeta] = useState<{ userVersion?: number; dbPath?: string } | null>(
    null
  )

  const refresh = useCallback(async () => {
    setLoading(true)
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

    return {
      totalAccounts,
      failedAccounts,
      totalRequests,
      totalErrors,
      totalTokens,
      avgDurationMs,
    }
  }, [accounts])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">Stats window</span>
          <Select value={windowPreset} onValueChange={(v) => setWindowPreset(v as WindowPreset)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="86400000">Last 24h</SelectItem>
              <SelectItem value="604800000">Last 7d</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <ShimmerButton
          onClick={refresh}
          disabled={loading}
          background="hsl(var(--primary))"
          className="h-9 px-4"
        >
          {loading ? "Refreshing..." : "Refresh"}
        </ShimmerButton>

        <div className="text-muted-foreground ml-auto text-sm">
          {meta?.dbPath ? `DB v${meta.userVersion ?? "?"} · ${meta.dbPath}` : null}
        </div>
      </div>

      <BentoGrid className="auto-rows-min grid-cols-1 gap-3 md:grid-cols-3">
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

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>
            Click an account to filter requests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Remaining</TableHead>
                <TableHead>Requests</TableHead>
                <TableHead>Errors</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Avg ms</TableHead>
                <TableHead>Last req</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 && !loading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-muted-foreground">
                    No data.
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((a) => {
                  const failed = a.runtime?.failed
                  const statusBadge = failed ? (
                    <Badge variant="destructive">failed</Badge>
                  ) : (
                    <Badge variant="secondary">ok</Badge>
                  )

                  const remaining = a.runtime?.unlimited ? (
                    <Badge variant="secondary">unlimited</Badge>
                  ) : (
                    fmtNum(a.runtime?.remaining)
                  )

                  const last = a.stats?.last_request_at_ms
                    ? fmtIso(a.stats.last_request_at_ms)
                    : ""

                  return (
                    <TableRow key={a.account_id}>
                      <TableCell className="font-mono">
                        <a
                          href={`#/requests?account_id=${encodeURIComponent(a.account_id)}`}
                          className="underline decoration-border hover:decoration-foreground"
                        >
                          {a.account_id}
                        </a>
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
                      <TableCell>{remaining}</TableCell>
                      <TableCell>{fmtNum(a.stats?.request_count)}</TableCell>
                      <TableCell>{fmtNum(a.stats?.error_count)}</TableCell>
                      <TableCell>{fmtNum(a.stats?.tokens_total)}</TableCell>
                      <TableCell>
                        {a.stats?.avg_duration_ms != null
                          ? fmtNum(Math.round(a.stats.avg_duration_ms))
                          : ""}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{last}</TableCell>
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
