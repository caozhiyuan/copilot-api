import { ArrowLeftIcon, DownloadIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Link, useLocation, useParams } from "react-router-dom"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminRequestItem,
  getAdminRequestDetail,
} from "@/lib/admin-api"
import { fmtLocalDateTime, fmtNum } from "@/lib/format"
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
        toast.error("Failed to load request", { description: msg })
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
      toast.success("Copied JSON")
    } catch (err) {
      toast.error("Copy failed", { description: String(err) })
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
      toast.success("Downloaded JSON")
    } catch (err) {
      toast.error("Download failed", { description: String(err) })
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
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
          <CardTitle>Request</CardTitle>
          <CardDescription>Request not found.</CardDescription>
        </CardHeader>
        <CardContent>
          <InlineAlert
            variant="warning"
            title="Request not found"
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
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to={backTo}>
            <ArrowLeftIcon className="size-4" />
            Back
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
                <Badge variant="outline">dur_ms: {fmtNum(item.duration_ms)}</Badge>
              ) : null}
              {item.ttfb_ms != null ? (
                <Badge variant="outline">ttfb_ms: {fmtNum(item.ttfb_ms)}</Badge>
              ) : null}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              {fmtLocalDateTime(item.started_at_ms)}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell className="w-36 text-muted-foreground">time</TableCell>
                  <TableCell className="font-mono text-xs">
                    {fmtLocalDateTime(item.started_at_ms)}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">path</TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link
                      to={`/requests?path=${encodeURIComponent(item.path)}`}
                      className="underline decoration-border hover:decoration-foreground"
                    >
                      {item.path}
                    </Link>
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">endpoint</TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.upstream_endpoint || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">account</TableCell>
                  <TableCell className="font-mono text-xs">
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
                  <TableCell className="text-muted-foreground">model</TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.upstream_model || ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">client</TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.client_ip || ""}
                    {item.user_agent ? ` (${item.user_agent})` : ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">tokens</TableCell>
                  <TableCell className="font-mono text-xs">
                    in={item.tokens_input ?? ""} out={item.tokens_output ?? ""} total={
                      item.tokens_total ?? ""
                    } cached={item.tokens_cached_input ?? ""}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">quota</TableCell>
                  <TableCell className="font-mono text-xs">
                    before={item.premium_remaining_before ?? ""} after={
                      item.premium_remaining_after ?? ""
                    } diff={item.premium_remaining_diff ?? ""} ({quota})
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Raw</CardTitle>
            <CardDescription>Full record as JSON.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                placeholder="Search key/value"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="sm:max-w-xs"
              />
              <div className="flex items-center gap-2 sm:ml-auto">
                <Button type="button" variant="outline" size="sm" onClick={downloadRaw}>
                  <DownloadIcon className="size-4" />
                  Download
                </Button>
                <RainbowButton onClick={() => void copyRaw()} className="h-9 px-4">
                  Copy JSON
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
