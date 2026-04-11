import {
  ArrowLeftIcon,
  DownloadIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useLocation, useParams } from "react-router-dom"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminRequestItem,
  getAdminRequestDetail,
} from "@/lib/admin-api"
import { fmtDurationSeconds, fmtLocalDateTime, fmtNum } from "@/lib/format"
import { i18n } from "@/lib/i18n"
import { JsonViewer } from "@/components/json/json-viewer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const EMPTY = "—"

function StatusBadge({ status }: { status: number }): React.JSX.Element {
  return status >= 400 ? (
    <Badge variant="destructive">{status}</Badge>
  ) : (
    <Badge variant="secondary">{status}</Badge>
  )
}

function SectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell
        colSpan={2}
        className="bg-muted/30 py-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase"
      >
        {label}
      </TableCell>
    </TableRow>
  )
}

function FieldLabel({
  label,
  tooltip,
}: {
  label: string
  tooltip?: string
}): React.JSX.Element {
  if (!tooltip) return <>{label}</>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dashed decoration-current/30 underline-offset-2">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-60">
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export function RequestDetailPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { requestId = "" } = useParams()
  const location = useLocation()

  const fromSearch = (location.state as { fromSearch?: string } | null)
    ?.fromSearch
  const backTo = fromSearch ? `/requests?${fromSearch}` : "/requests"

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [item, setItem] = useState<AdminRequestItem | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  useEffect(() => {
    let cancelled = false

    async function run(): Promise<void> {
      setLoading(true)
      setFetchError(null)
      try {
        const data = await getAdminRequestDetail(requestId)
        if (cancelled) return
        setItem(data.item)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof AdminApiError ? err.message : String(err)
        setFetchError(msg)
        setItem(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    if (requestId) void run()

    return () => {
      cancelled = true
    }
  }, [requestId])

  function refresh(): void {
    setRefreshing(true)
    getAdminRequestDetail(requestId)
      .then((data) => {
        setItem(data.item)
        setFetchError(null)
      })
      .catch((err: unknown) => {
        const msg = err instanceof AdminApiError ? err.message : String(err)
        toast.error(i18n.t("requestDetailPage.loadFailedTitle"), {
          description: msg,
        })
      })
      .finally(() => setRefreshing(false))
  }

  function retry(): void {
    setLoading(true)
    setFetchError(null)
    getAdminRequestDetail(requestId)
      .then((data) => {
        setItem(data.item)
      })
      .catch((err: unknown) => {
        const msg = err instanceof AdminApiError ? err.message : String(err)
        setFetchError(msg)
        setItem(null)
      })
      .finally(() => setLoading(false))
  }

  async function copyRaw(): Promise<void> {
    if (!item) return

    try {
      const raw = JSON.stringify(item, null, 2)
      await navigator.clipboard.writeText(raw)
      toast.success(t("requestDetailPage.toast.copiedJson"))
    } catch (err) {
      toast.error(t("requestDetailPage.toast.copyFailed"), {
        description: String(err),
      })
    }
  }

  function downloadRaw(): void {
    if (!item) return

    try {
      const raw = JSON.stringify(item, null, 2)
      const blob = new Blob([raw], { type: "application/json" })
      const url = URL.createObjectURL(blob)

      const a = document.createElement("a")
      a.href = url
      a.download = `${item.request_id}.json`
      a.click()

      URL.revokeObjectURL(url)
      toast.success(t("requestDetailPage.toast.downloadedJson"))
    } catch (err) {
      toast.error(t("requestDetailPage.toast.downloadFailed"), {
        description: String(err),
      })
    }
  }

  /* Loading state */
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("requestDetailPage.title")}</CardTitle>
          <CardDescription>
            <Skeleton className="h-4 w-40" />
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        </CardContent>
      </Card>
    )
  }

  /* Error / not-found state */
  if (fetchError || !item) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to={backTo}>
              <ArrowLeftIcon className="size-4" />
              {t("common.back")}
            </Link>
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("requestDetailPage.title")}</CardTitle>
            <CardDescription>
              {t("requestDetailPage.notFoundDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <InlineAlert
              variant="warning"
              title={
                fetchError
                  ? t("requestDetailPage.loadFailedTitle")
                  : t("requestDetailPage.notFoundTitle")
              }
              description={fetchError || `request_id: ${requestId}`}
            />
            <Button variant="outline" size="sm" onClick={retry}>
              <RefreshCwIcon className="size-4" />
              {t("common.retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const quota = item.premium_unlimited_after
    ? "∞"
    : item.premium_remaining_after != null
      ? fmtNum(item.premium_remaining_after)
      : ""

  return (
    <div className="space-y-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
      {/* Back + Refresh toolbar */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to={backTo}>
            <ArrowLeftIcon className="size-4" />
            {t("common.back")}
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={refreshing}
          onClick={refresh}
        >
          {refreshing ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      {/* Header card */}
      <Card
        className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 fill-mode-backwards"
        style={{ animationDelay: "50ms" }}
      >
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{item.request_id}</span>
            <StatusBadge status={item.http_status} />
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            {fmtLocalDateTime(item.started_at_ms)}
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-[1fr_2fr]">
        {/* Summary card */}
        <Card
          className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 fill-mode-backwards"
          style={{ animationDelay: "100ms" }}
        >
          <CardHeader>
            <CardTitle>{t("requestDetailPage.summaryTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {/* ── Request ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.request")}
                />
                <TableRow>
                  <TableCell className="w-36 text-muted-foreground">
                    {t("requestDetailPage.fields.time")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtLocalDateTime(item.started_at_ms) || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.path")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    <Link
                      to={`/requests?path=${encodeURIComponent(item.path)}`}
                      className="underline decoration-border hover:decoration-foreground"
                    >
                      {item.path}
                    </Link>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.endpoint")}
                      tooltip={t("requestDetailPage.fieldTooltip.endpoint")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_endpoint || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.model")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.upstream_model || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.duration")}
                      tooltip={t("requestDetailPage.fieldTooltip.duration")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtDurationSeconds(item.duration_ms) || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.ttfb")}
                      tooltip={t("requestDetailPage.fieldTooltip.ttfb")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtDurationSeconds(item.ttfb_ms) || EMPTY}
                  </TableCell>
                </TableRow>

                {/* ── Routing ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.routing")}
                />
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.account")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.account_id ? (
                      <Link
                        to={`/requests?account_id=${encodeURIComponent(item.account_id)}`}
                        className="underline decoration-border hover:decoration-foreground"
                      >
                        {item.account_id}
                      </Link>
                    ) : (
                      EMPTY
                    )}
                    {item.affinity_hit ? (
                      <Badge variant="outline" className="ml-2">
                        {t("requestDetailPage.fields.affinityHit")}
                      </Badge>
                    ) : null}
                  </TableCell>
                </TableRow>
                {item.affinity_cache_key ? (
                  <TableRow>
                    <TableCell className="text-muted-foreground">
                      <FieldLabel
                        label={t("requestDetailPage.fields.affinityCacheKey")}
                        tooltip={t(
                          "requestDetailPage.fieldTooltip.affinityCacheKey",
                        )}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-normal break-words">
                      {item.affinity_cache_key}
                    </TableCell>
                  </TableRow>
                ) : null}
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.affinityKeyUsed")}
                      tooltip={t("requestDetailPage.fieldTooltip.affinityKeyUsed")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.affinity_key_used || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.affinityKeySource")}
                      tooltip={t("requestDetailPage.fieldTooltip.affinityKeySource")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.affinity_key_source || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.selectionReason")}
                      tooltip={t("requestDetailPage.fieldTooltip.selectionReason")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.selection_reason || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.initiator")}
                      tooltip={t("requestDetailPage.fieldTooltip.initiator")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.initiator || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.upstreamRequestId")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.upstreamRequestId",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_request_id || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.upstreamErrorMessageRaw")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.upstreamErrorMessageRaw",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_error_message_raw || EMPTY}
                  </TableCell>
                </TableRow>

                {/* ── Client ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.client")}
                />
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.userId")}
                      tooltip={t("requestDetailPage.fieldTooltip.userId")}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.user_id || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.safetyIdentifier")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.safetyIdentifier",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.safety_identifier || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    <FieldLabel
                      label={t("requestDetailPage.fields.promptCacheKey")}
                      tooltip={t(
                        "requestDetailPage.fieldTooltip.promptCacheKey",
                      )}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.prompt_cache_key || EMPTY}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.client")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.client_ip || EMPTY}
                    {item.user_agent ? ` (${item.user_agent})` : ""}
                  </TableCell>
                </TableRow>

                {/* ── Usage ── */}
                <SectionHeader
                  label={t("requestDetailPage.sections.usage")}
                />
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.tokens")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.in")}:
                        </span>{" "}
                        {item.tokens_input != null
                          ? fmtNum(item.tokens_input)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.out")}:
                        </span>{" "}
                        {item.tokens_output != null
                          ? fmtNum(item.tokens_output)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.total")}:
                        </span>{" "}
                        {item.tokens_total != null
                          ? fmtNum(item.tokens_total)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.tokens.cached")}:
                        </span>{" "}
                        {item.tokens_cached_input != null
                          ? fmtNum(item.tokens_cached_input)
                          : EMPTY}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.quota")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.quota.before")}:
                        </span>{" "}
                        {item.premium_remaining_before != null
                          ? fmtNum(item.premium_remaining_before)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.quota.after")}:
                        </span>{" "}
                        {item.premium_remaining_after != null
                          ? fmtNum(item.premium_remaining_after)
                          : EMPTY}
                      </span>
                      <span>
                        <span className="text-muted-foreground">
                          {t("requestDetailPage.quota.diff")}:
                        </span>{" "}
                        {item.premium_remaining_diff != null
                          ? fmtNum(item.premium_remaining_diff)
                          : EMPTY}
                        {quota ? ` (${quota})` : ""}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Raw JSON card */}
        <Card
          className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300 fill-mode-backwards"
          style={{ animationDelay: "150ms" }}
        >
          <CardHeader>
            <CardTitle>{t("requestDetailPage.rawTitle")}</CardTitle>
            <CardDescription>
              {t("requestDetailPage.rawDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                placeholder={t("requestDetailPage.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 sm:max-w-xs"
              />
              <div className="flex items-center gap-2 sm:ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={downloadRaw}
                >
                  <DownloadIcon className="size-4" />
                  {t("common.download")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyRaw()}
                >
                  {t("common.copyJson")}
                </Button>
              </div>
            </div>

            <JsonViewer value={item} search={search} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
