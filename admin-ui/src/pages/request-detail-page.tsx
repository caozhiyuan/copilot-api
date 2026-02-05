import { ArrowLeftIcon, DownloadIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"

import {
  AdminApiError,
  type AdminRequestItem,
  getAdminRequestDetail,
} from "@/lib/admin-api"
import { fmtLocalDateTime, fmtNum } from "@/lib/format"
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
import { BorderBeam } from "@/components/ui/border-beam"
import { InlineAlert } from "@/components/ui/inline-alert"
import { RainbowButton } from "@/components/ui/rainbow-button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table"

function StatusBadge({ status }: { status: number }): React.JSX.Element {
  return status >= 400 ? (
    <Badge variant="destructive">{status}</Badge>
  ) : (
    <Badge variant="secondary">{status}</Badge>
  )
}

export function RequestDetailPage(): React.JSX.Element {
  const { t } = useTranslation()
  const { requestId = "" } = useParams()
  const location = useLocation()

  const fromSearch = (location.state as { fromSearch?: string } | null)?.fromSearch
  const backTo = fromSearch ? `/requests?${fromSearch}` : "/requests"

  const [loading, setLoading] = useState(true)
  const [item, setItem] = useState<AdminRequestItem | null>(null)
  const [search, setSearch] = useState("")

  useEffect(() => {
    let cancelled = false

    async function run(): Promise<void> {
      setLoading(true)
      try {
        const data = await getAdminRequestDetail(requestId)
        if (cancelled) return
        setItem(data.item)
      } catch (err) {
        const msg = err instanceof AdminApiError ? err.message : String(err)
        toast.error(i18n.t("requestDetailPage.loadFailedTitle"), { description: msg })
        if (cancelled) return
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

  async function copyRaw(): Promise<void> {
    if (!item) return

    try {
      const raw = JSON.stringify(item, null, 2)
      await navigator.clipboard.writeText(raw)
      toast.success(t("requestDetailPage.toast.copiedJson"))
    } catch (err) {
      toast.error(t("requestDetailPage.toast.copyFailed"), { description: String(err) })
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
      toast.error(t("requestDetailPage.toast.downloadFailed"), { description: String(err) })
    }
  }

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

  if (!item) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("requestDetailPage.title")}</CardTitle>
          <CardDescription>{t("requestDetailPage.notFoundDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <InlineAlert
            variant="warning"
            title={t("requestDetailPage.notFoundTitle")}
            description={`request_id: ${requestId}`}
          />
        </CardContent>
      </Card>
    )
  }

  const quota = item.premium_unlimited_after
    ? "∞"
    : item.premium_remaining_after != null
      ? fmtNum(item.premium_remaining_after)
      : ""

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

      <div className="relative">
        <BorderBeam className="opacity-40" borderWidth={1} />
        <Card className="relative">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{item.request_id}</span>
              <StatusBadge status={item.http_status} />
              {item.duration_ms != null ? (
                <Badge variant="outline">{t("requestDetailPage.badges.durMs")}: {fmtNum(item.duration_ms)}</Badge>
              ) : null}
              {item.ttfb_ms != null ? (
                <Badge variant="outline">{t("requestDetailPage.badges.ttfbMs")}: {fmtNum(item.ttfb_ms)}</Badge>
              ) : null}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              {fmtLocalDateTime(item.started_at_ms)}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-[1fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t("requestDetailPage.summaryTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell className="w-36 text-muted-foreground">
                    {t("requestDetailPage.fields.time")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtLocalDateTime(item.started_at_ms)}
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
                    {t("requestDetailPage.fields.endpoint")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_endpoint || ""}
                  </TableCell>
                </TableRow>
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
                      ""
                    )}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.userId")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.user_id || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.safetyIdentifier")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.safety_identifier || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.promptCacheKey")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.prompt_cache_key || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.initiator")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.initiator || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.upstreamRequestId")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.upstream_request_id || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.model")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.upstream_model || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.client")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {item.client_ip || ""}
                    {item.user_agent ? ` (${item.user_agent})` : ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.tokens")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {t("requestDetailPage.tokens.in")}={item.tokens_input ?? ""}{" "}
                    {t("requestDetailPage.tokens.out")}={item.tokens_output ?? ""}{" "}
                    {t("requestDetailPage.tokens.total")}={item.tokens_total ?? ""}{" "}
                    {t("requestDetailPage.tokens.cached")}={item.tokens_cached_input ?? ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">
                    {t("requestDetailPage.fields.quota")}
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-normal break-words">
                    {t("requestDetailPage.quota.before")}={item.premium_remaining_before ?? ""}{" "}
                    {t("requestDetailPage.quota.after")}={item.premium_remaining_after ?? ""}{" "}
                    {t("requestDetailPage.quota.diff")}={item.premium_remaining_diff ?? ""} ({quota})
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("requestDetailPage.rawTitle")}</CardTitle>
            <CardDescription>{t("requestDetailPage.rawDescription")}</CardDescription>
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
                <Button type="button" variant="outline" size="sm" onClick={downloadRaw}>
                  <DownloadIcon className="size-4" />
                  {t("common.download")}
                </Button>
                <RainbowButton onClick={() => void copyRaw()} size="sm">
                  {t("common.copyJson")}
                </RainbowButton>
              </div>
            </div>

            <JsonViewer value={item} search={search} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
