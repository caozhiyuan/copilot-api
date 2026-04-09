import { DownloadIcon, PlusIcon, RefreshCwIcon, UserPlusIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { AnimatePresence, motion } from "motion/react"

import {
  AdminApiError,
  type AdminAccountItem,
  getAdminAccounts,
  getAdminMeta,
} from "@/lib/admin-api"
import { fmtDurationSeconds, fmtLocalDateTime, fmtNum } from "@/lib/format"
import { i18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import { Button } from "@/components/ui/button"
import { RainbowButton } from "@/components/ui/rainbow-button"
import { AddAccountDialog } from "@/components/add-account-dialog"
import { DeleteAccountDialog } from "@/components/delete-account-dialog"

type WindowPreset = "86400000" | "604800000" | "this_month"

type SortBy = "account" | "requests" | "errors" | "tokens" | "last_req"

function sum(items: Array<number | undefined>): number {
  return items.reduce<number>((acc, x) => acc + (x ?? 0), 0)
}

function windowPresetToRange(
  preset: WindowPreset,
  nowMs: number
): { sinceMs: number; fromMs: string; toMs: string } {
  if (preset === "this_month") {
    const now = new Date(nowMs)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    return { sinceMs: startOfMonth, fromMs: String(startOfMonth), toMs: String(nowMs) }
  }

  const windowMs = Number(preset)
  const sinceMs = nowMs - windowMs
  return { sinceMs, fromMs: String(sinceMs), toMs: String(nowMs) }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function fmtNumOrDash(n?: number | null): string {
  const s = fmtNum(n)
  return s || "—"
}

function calcWeightedAvgDurationSeconds(accounts: AdminAccountItem[]): number {
  let totalReq = 0
  let weightedMs = 0

  for (const a of accounts) {
    const req = a.stats?.request_count ?? 0
    const avgMs = a.stats?.avg_duration_ms ?? 0
    if (req > 0 && avgMs > 0) {
      totalReq += req
      weightedMs += req * avgMs
    }
  }

  return totalReq > 0 ? weightedMs / totalReq / 1000 : 0
}

function KpiValue({
  value,
  decimalPlaces = 0,
}: {
  value: number
  decimalPlaces?: number
}): React.JSX.Element {
  return <NumberTicker value={value} decimalPlaces={decimalPlaces} />
}

function KpiLabel({
  label,
  tooltip,
}: {
  label: string
  tooltip?: string
}): React.JSX.Element {
  if (!tooltip) {
    return <div className="text-muted-foreground text-xs">{label}</div>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="text-muted-foreground cursor-help text-xs underline decoration-dashed decoration-current/30 underline-offset-2">
          {label}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-60">
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  )
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
  null, // Actions column
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
  const { t } = useTranslation()

  const [windowPreset, setWindowPreset] = useState<WindowPreset>("this_month")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState("")
  const [sortBy, setSortBy] = useState<SortBy>("requests")

  const [accounts, setAccounts] = useState<AdminAccountItem[]>([])
  const [meta, setMeta] = useState<{ userVersion?: number; dbPath?: string } | null>(
    null
  )

  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState("")
  const [reauthDialogOpen, setReauthDialogOpen] = useState(false)
  const [reauthTargetId, setReauthTargetId] = useState("")
  const autoRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadInFlightRef = useRef(false)
  const queuedRefreshRef = useRef(false)

  const refresh = useCallback(async () => {
    if (loadInFlightRef.current) {
      queuedRefreshRef.current = true
      return
    }

    loadInFlightRef.current = true
    setLoading(true)
    setError(null)
    try {
      const nowMs = Date.now()
      const { sinceMs } = windowPresetToRange(windowPreset, nowMs)

      const [accRes, metaRes] = await Promise.all([
        getAdminAccounts({ sinceMs, includeStats: true }),
        getAdminMeta(),
      ])

      setAccounts(accRes.items)
      setMeta(metaRes)
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error(i18n.t("accountsPage.loadFailedTitle"), { description: msg })
    } finally {
      loadInFlightRef.current = false
      setLoading(false)
      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false
        void refresh()
      }
    }
  }, [windowPreset])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Auto-refresh
  const [autoRefreshMs, setAutoRefreshMs] = useState<number>(0)

  useEffect(() => {
    let disposed = false

    if (autoRefreshRef.current) {
      clearTimeout(autoRefreshRef.current)
      autoRefreshRef.current = null
    }

    if (autoRefreshMs > 0) {
      const scheduleNextRefresh = () => {
        if (disposed) return
        autoRefreshRef.current = setTimeout(async () => {
          if (loadInFlightRef.current) {
            scheduleNextRefresh()
            return
          }

          try {
            await refresh()
          } finally {
            scheduleNextRefresh()
          }
        }, autoRefreshMs)
      }

      scheduleNextRefresh()
    }

    return () => {
      disposed = true
      if (autoRefreshRef.current) {
        clearTimeout(autoRefreshRef.current)
        autoRefreshRef.current = null
      }
    }
  }, [autoRefreshMs, refresh])

  // Keyboard shortcuts: R = refresh, N = add account
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip when user is typing in an input, textarea, select, or dialog
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if ((e.target as HTMLElement)?.closest("[role=dialog]")) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === "r" || e.key === "R") {
        e.preventDefault()
        void refresh()
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault()
        setAddDialogOpen(true)
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [refresh])

  // CSV export
  function escapeCsvCell(value: string): string {
    const neutralized = /^[=+\-@]/u.test(value) ? `'${value}` : value
    return `"${neutralized.replaceAll('"', '""')}"`
  }

  const handleExportCsv = useCallback(() => {
    if (accounts.length === 0) return

    const headers = [
      "account_id",
      "status",
      "requests",
      "errors",
      "tokens",
      "avg_duration_s",
      "last_request",
    ]
    const rows = accounts.map((a) => [
      a.account_id,
      a.runtime?.failed ? "failed" : "ok",
      String(a.stats?.request_count ?? 0),
      String(a.stats?.error_count ?? 0),
      String(a.stats?.tokens_total ?? 0),
      fmtDurationSeconds(a.stats?.avg_duration_ms),
      a.stats?.last_request_at_ms
        ? new Date(a.stats.last_request_at_ms).toISOString()
        : "",
    ])

    const csv = [
      headers.join(","),
      ...rows.map((r) => r.map((c) => escapeCsvCell(c)).join(",")),
    ].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `accounts-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(t("accountsPage.exportSuccess"))
  }, [accounts, t])

  const kpis = useMemo(() => {
    const totalAccounts = accounts.length
    const failedAccounts = accounts.filter((a) => a.runtime?.failed).length

    const totalRequests = sum(accounts.map((a) => a.stats?.request_count))
    const totalErrors = sum(accounts.map((a) => a.stats?.error_count))
    const totalTokens = sum(accounts.map((a) => a.stats?.tokens_total))
    const avgDurationSeconds = calcWeightedAvgDurationSeconds(accounts)

    const errorRatePct = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0
    const tokensPerRequest = totalRequests > 0 ? totalTokens / totalRequests : 0

    return {
      totalAccounts,
      failedAccounts,
      totalRequests,
      totalErrors,
      totalTokens,
      avgDurationSeconds,
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

  const nowMs = Date.now()
  const { fromMs, toMs } = windowPresetToRange(windowPreset, nowMs)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-sm">{t("accountsPage.statsWindowLabel")}</span>
          <Select value={windowPreset} onValueChange={(v) => setWindowPreset(v as WindowPreset)}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="86400000">{t("accountsPage.window.last24h")}</SelectItem>
              <SelectItem value="604800000">{t("accountsPage.window.last7d")}</SelectItem>
              <SelectItem value="this_month">{t("accountsPage.window.thisMonth")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} />
          {loading ? t("common.refreshing") : t("common.refresh")}
        </Button>

        <div className="flex items-center gap-2">
          {autoRefreshMs > 0 && (
            <span className="relative flex h-2 w-2">
              <span className="bg-primary absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full opacity-75" />
              <span className="bg-primary relative inline-flex h-2 w-2 rounded-full" />
            </span>
          )}
          <span className="text-muted-foreground text-sm">{t("accountsPage.autoRefreshLabel")}</span>
          <Select value={String(autoRefreshMs)} onValueChange={(v) => setAutoRefreshMs(Number(v))}>
            <SelectTrigger size="sm" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t("accountsPage.autoRefresh.off")}</SelectItem>
              <SelectItem value="30000">{t("accountsPage.autoRefresh.30s")}</SelectItem>
              <SelectItem value="60000">{t("accountsPage.autoRefresh.60s")}</SelectItem>
              <SelectItem value="300000">{t("accountsPage.autoRefresh.5m")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <RainbowButton size="sm" onClick={() => setAddDialogOpen(true)}>
          <PlusIcon className="size-4" />
          {t("accountManagement.addAccount")}
        </RainbowButton>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExportCsv}
              disabled={accounts.length === 0}
              aria-label={t("accountsPage.exportCsvAria")}
            >
              <DownloadIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("accountsPage.exportCsv")}</TooltipContent>
        </Tooltip>

        <div className="text-muted-foreground ml-auto text-xs opacity-60">
          {meta?.dbPath
            ? t("accountsPage.dbInfo", {
                version: meta.userVersion ?? "?",
                path: meta.dbPath,
              })
            : null}
        </div>
      </div>

      {error ? (
        <InlineAlert
          variant="error"
          title={t("accountsPage.loadFailedTitle")}
          description={error}
          actionLabel={t("common.retry")}
          onAction={() => void refresh()}
        />
      ) : null}

      <BentoGrid className="auto-rows-min grid-cols-1 gap-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">
        {[
          { label: t("nav.accounts"), tooltip: t("accountsPage.kpiTooltip.accounts"), value: kpis.totalAccounts },
          { label: t("common.failed"), tooltip: t("accountsPage.kpiTooltip.failed"), value: kpis.failedAccounts },
          { label: t("nav.requests"), tooltip: t("accountsPage.kpiTooltip.requests"), value: kpis.totalRequests },
          { label: t("common.errors"), tooltip: t("accountsPage.kpiTooltip.errors"), value: kpis.totalErrors },
          { label: t("common.errorRate"), tooltip: t("accountsPage.kpiTooltip.errorRate"), value: kpis.errorRatePct, decimal: 1, suffix: "%" },
          { label: t("common.tokensPerRequest"), tooltip: t("accountsPage.kpiTooltip.tokensPerRequest"), value: kpis.tokensPerRequest, decimal: 1 },
          { label: t("common.tokens"), tooltip: t("accountsPage.kpiTooltip.tokens"), value: kpis.totalTokens },
          { label: t("common.avgDurationMs"), tooltip: t("accountsPage.kpiTooltip.avgDuration"), value: kpis.avgDurationSeconds, decimal: 1 },
        ].map((kpi, i) => (
          <MagicCard
            key={kpi.label}
            className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 rounded-xl fill-mode-backwards"
            style={{ animationDelay: `${i * 60}ms`, animationDuration: "400ms" }}
          >
            <div className="p-4">
              <KpiLabel label={kpi.label} tooltip={kpi.tooltip} />
              <div className="mt-1 flex items-baseline gap-1 text-2xl font-semibold">
                <KpiValue value={kpi.value} decimalPlaces={kpi.decimal ?? 0} />
                {kpi.suffix ? <span className="text-muted-foreground text-sm">{kpi.suffix}</span> : null}
              </div>
            </div>
          </MagicCard>
        ))}
      </BentoGrid>

      {!loading && accounts.length === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center gap-4 text-center">
            <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full">
              <UserPlusIcon className="text-muted-foreground size-7" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-lg font-semibold">{t("accountsPage.empty.noAccountsTitle")}</h3>
              <p className="text-muted-foreground mx-auto max-w-sm text-sm">
                {t("accountsPage.empty.noAccountsDescription")}
              </p>
            </div>
            <Button size="lg" onClick={() => setAddDialogOpen(true)} className="mt-2">
              <PlusIcon className="size-4" />
              {t("accountsPage.empty.noAccountsCta")}
            </Button>
          </CardContent>
        </Card>
      ) : (
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t("nav.accounts")}</CardTitle>
          <CardDescription className="hidden sm:block">{t("accountsPage.tableDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Input
              placeholder={t("accountsPage.filterAccountPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 sm:max-w-xs"
            />

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">{t("accountsPage.sortByLabel")}</span>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="requests">{t("nav.requests")}</SelectItem>
                  <SelectItem value="errors">{t("common.errors")}</SelectItem>
                  <SelectItem value="tokens">{t("common.tokens")}</SelectItem>
                  <SelectItem value="last_req">{t("common.lastRequest")}</SelectItem>
                  <SelectItem value="account">{t("common.account")}</SelectItem>
                </SelectContent>
              </Select>

              <div className="text-muted-foreground text-sm tabular-nums">
                {visibleAccounts.length}/{accounts.length}
              </div>
            </div>
          </div>

          <Table glow stickyHeader className="[&_th]:h-9 [&_td]:py-1.5">
            <TableHeader>
              <TableRow>
                <TableHead>{t("common.account")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead className={cn(accountsTableColVisibility[2])}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dashed decoration-current/30 underline-offset-2">
                        {t("accountsPage.premiumReq")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-60">
                      <p>{t("accountsPage.tableTooltip.premiumReq")}</p>
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
                <TableHead>{t("nav.requests")}</TableHead>
                <TableHead>{t("common.errors")}</TableHead>
                <TableHead className={cn(accountsTableColVisibility[5])}>
                  {t("common.tokens")}
                </TableHead>
                <TableHead className={cn(accountsTableColVisibility[6])}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dashed decoration-current/30 underline-offset-2">
                        {t("common.avgMs")}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-60">
                      <p>{t("accountsPage.tableTooltip.avgMs")}</p>
                    </TooltipContent>
                  </Tooltip>
                </TableHead>
                <TableHead className={cn(accountsTableColVisibility[7])}>
                  {t("common.lastRequest")}
                </TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
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
                      title={t("accountsPage.empty.noMatchesTitle")}
                      description={t("accountsPage.empty.noMatchesDescription")}
                      actionLabel={query.trim() ? t("common.clearFilter") : undefined}
                      onAction={query.trim() ? () => setQuery("") : undefined}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                <AnimatePresence initial={false}>
                {visibleAccounts.map((a) => {
                  const failed = a.runtime?.failed
                  const statusBadge = failed ? (
                    <Badge variant="destructive">{t("common.statusFailed")}</Badge>
                  ) : (
                    <Badge variant="secondary">{t("common.statusOk")}</Badge>
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
                    <Badge variant="secondary">{t("common.unlimited")}</Badge>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2 text-xs whitespace-nowrap">
                        <div className="flex items-baseline gap-1">
                          <span className="text-muted-foreground">{t("common.used")}</span>
                          <span className="tabular-nums font-medium">
                            {fmtNumOrDash(usedQuota)}
                          </span>
                        </div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-muted-foreground">{t("common.remaining")}</span>
                          <span className="tabular-nums font-medium">
                            {fmtNumOrDash(remainingQuota)}
                          </span>
                        </div>
                      </div>
                      {percentUsed != null ? (
                        <Progress
                          value={percentUsed}
                          className="h-1.5"
                          aria-label={t("accountsPage.premiumQuotaUsedAria")}
                        />
                      ) : null}
                    </div>
                  )

                  const last = a.stats?.last_request_at_ms
                    ? fmtLocalDateTime(a.stats.last_request_at_ms)
                    : ""

                  return (
                    <motion.tr
                      key={a.account_id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15, ease: "easeOut" }}
                      data-slot="table-row"
                      className="hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors"
                    >
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
                        {fmtDurationSeconds(a.stats?.avg_duration_ms)}
                      </TableCell>
                      <TableCell className={cn(accountsTableColVisibility[7], "font-mono text-xs")}>
                        {last}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant={failed ? "default" : "ghost"}
                            size="sm"
                            className="h-8 px-2.5 text-xs"
                            aria-label={t("accountManagement.reauthAriaLabel", { id: a.account_id })}
                            onClick={() => {
                              setReauthTargetId(a.account_id)
                              setReauthDialogOpen(true)
                            }}
                          >
                            {t("accountManagement.reauth")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive h-8 px-2.5 text-xs"
                            aria-label={t("accountManagement.deleteAriaLabel", { id: a.account_id })}
                            onClick={() => {
                              setDeleteTargetId(a.account_id)
                              setDeleteDialogOpen(true)
                            }}
                          >
                            {t("accountManagement.delete")}
                          </Button>
                        </div>
                      </TableCell>
                    </motion.tr>
                  )
                })}
                </AnimatePresence>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      )}

      <AddAccountDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onSuccess={refresh}
      />

      <AddAccountDialog
        open={reauthDialogOpen}
        onOpenChange={setReauthDialogOpen}
        onSuccess={refresh}
        reauthAccountId={reauthTargetId}
      />

      <DeleteAccountDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        accountId={deleteTargetId}
        onDeleted={refresh}
      />
    </div>
  )
}
