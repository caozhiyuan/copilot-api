import { useEffect, useMemo, useState } from "react"
import { useParams } from "react-router-dom"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminRequestItem,
  getAdminRequestDetail,
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
import { BorderBeam } from "@/components/ui/border-beam"
import { ShimmerButton } from "@/components/ui/shimmer-button"
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

  const [loading, setLoading] = useState(true)
  const [item, setItem] = useState<AdminRequestItem | null>(null)

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

  const raw = useMemo(() => {
    return item ? JSON.stringify(item, null, 2) : ""
  }, [item])

  async function copyRaw(): Promise<void> {
    if (!raw) return

    try {
      await navigator.clipboard.writeText(raw)
      toast.success("Copied JSON")
    } catch (err) {
      toast.error("Copy failed", { description: String(err) })
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
          <CardDescription>Loading...</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!item) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Request not found</CardTitle>
          <CardDescription>request_id: {requestId}</CardDescription>
        </CardHeader>
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
              {fmtIso(item.started_at_ms)}
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
                    {fmtIso(item.started_at_ms)}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-muted-foreground">path</TableCell>
                  <TableCell className="font-mono text-xs">{item.path}</TableCell>
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
                    {item.account_id || ""}
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
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div>
              <CardTitle>Raw</CardTitle>
              <CardDescription>Full record as JSON.</CardDescription>
            </div>
            <ShimmerButton
              onClick={() => void copyRaw()}
              background="hsl(var(--primary))"
              className="h-9 px-4"
            >
              Copy JSON
            </ShimmerButton>
          </CardHeader>
          <CardContent>
            <pre className="bg-muted overflow-auto rounded-md p-3 text-xs">
              {raw}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
