import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  AdminApiError,
  type AdminModelDetailsItem,
  getAdminModelDetails,
} from "@/lib/admin-api"
import { i18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { InlineAlert } from "@/components/ui/inline-alert"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const modelsTableColVisibility = [
  null,
  null,
  null,
  null,
  null,
  null,
  null,
] as const

function fmtTokensCompact(n?: number): string {
  if (n == null) return ""
  if (!Number.isFinite(n) || n <= 0) return ""
  if (n >= 1000) return `${Math.floor(n / 1000)}K`
  return String(Math.floor(n))
}

function ModelsTableSkeleton({ rows }: { rows: number }): React.JSX.Element {
  const cols = modelsTableColVisibility.length

  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <TableCell key={j} className={cn("py-3", modelsTableColVisibility[j])}>
              <Skeleton className={j === 0 ? "h-4 w-48" : "h-4 w-28"} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}

function FeatureBadges({
  supports,
}: {
  supports: AdminModelDetailsItem["capabilities"]["supports"]
}): React.JSX.Element {
  const { t } = useTranslation()

  const features: Array<{ key: string; label: string }> = []

  if (supports.tool_calls) {
    features.push({ key: "tool_calls", label: t("modelsPage.features.tools") })
  }

  if (supports.vision) {
    features.push({ key: "vision", label: t("modelsPage.features.vision") })
  }

  if (supports.structured_outputs) {
    features.push({
      key: "structured_outputs",
      label: t("modelsPage.features.structuredOutputs"),
    })
  }

  if (supports.streaming) {
    features.push({ key: "streaming", label: t("modelsPage.features.streaming") })
  }

  if (supports.parallel_tool_calls) {
    features.push({
      key: "parallel_tool_calls",
      label: t("modelsPage.features.parallelTools"),
    })
  }

  if (features.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <div className="flex flex-wrap gap-1 whitespace-normal">
      {features.map((f) => (
        <Badge key={f.key} variant="outline" className="text-xs">
          {f.label}
        </Badge>
      ))}
    </div>
  )
}

function EndpointBadges({
  endpoints,
}: {
  endpoints: AdminModelDetailsItem["supported_endpoints"]
}): React.JSX.Element {
  if (!endpoints || endpoints.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <div className="flex flex-wrap gap-1 whitespace-normal">
      {endpoints.map((ep) => (
        <Badge key={ep} variant="secondary" className="font-mono text-xs">
          {ep}
        </Badge>
      ))}
    </div>
  )
}

function AliasBadges({ aliases }: { aliases: string[] }): React.JSX.Element {
  if (aliases.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <div className="flex flex-wrap gap-1 whitespace-normal">
      {aliases.map((alias) => (
        <Badge key={alias} variant="outline" className="font-mono text-xs">
          {alias}
        </Badge>
      ))}
    </div>
  )
}

function ContextCell({
  limits,
}: {
  limits: AdminModelDetailsItem["capabilities"]["limits"]
}): React.JSX.Element {
  const ctx = fmtTokensCompact(limits.max_context_window_tokens)
  const out = fmtTokensCompact(limits.max_output_tokens)

  return (
    <div className="flex items-center gap-3 tabular-nums">
      <span className="text-muted-foreground">↓</span>
      <span>{ctx || "—"}</span>
      <span className="text-muted-foreground">↑</span>
      <span>{out || "—"}</span>
    </div>
  )
}

function MultiplierCell({
  billing,
}: {
  billing: AdminModelDetailsItem["billing"]
}): React.JSX.Element {
  const { t } = useTranslation()

  const mult = billing?.multiplier
  if (mult == null) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <div className="flex items-center gap-2 tabular-nums">
      <span>{mult}x</span>
      {billing?.is_premium ? (
        <Badge variant="default" className="text-xs">
          {t("modelsPage.badges.premium")}
        </Badge>
      ) : null}
    </div>
  )
}

export function ModelsPage(): React.JSX.Element {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<AdminModelDetailsItem[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const res = await getAdminModelDetails()
      setModels(res.items)
    } catch (err) {
      const msg = err instanceof AdminApiError ? err.message : String(err)
      setError(msg)
      toast.error(i18n.t("modelsPage.toast.loadFailed"), { description: msg })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      {error ? (
        <InlineAlert
          variant="error"
          title={t("modelsPage.loadFailedTitle")}
          description={error}
          actionLabel={t("common.retry")}
          onAction={() => void load()}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("modelsPage.title")}</CardTitle>
          <CardDescription>{t("modelsPage.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-muted-foreground text-sm">
            {t("modelsPage.totalCount", { count: models.length })}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("modelsPage.columns.name")}</TableHead>
                <TableHead className={cn(modelsTableColVisibility[1])}>
                  {t("modelsPage.columns.endpoints")}
                </TableHead>
                <TableHead className={cn(modelsTableColVisibility[2])}>
                  {t("modelsPage.columns.originalId")}
                </TableHead>
                <TableHead className={cn(modelsTableColVisibility[3])}>
                  {t("modelsPage.columns.aliases")}
                </TableHead>
                <TableHead>{t("modelsPage.columns.context")}</TableHead>
                <TableHead>{t("modelsPage.columns.features")}</TableHead>
                <TableHead>{t("modelsPage.columns.multiplier")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && models.length === 0 ? (
                <ModelsTableSkeleton rows={10} />
              ) : models.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={modelsTableColVisibility.length}>
                    <InlineAlert
                      variant="info"
                      title={t("modelsPage.empty.title")}
                      description={t("modelsPage.empty.description")}
                    />
                  </TableCell>
                </TableRow>
              ) : (
                models.map((model) => (
                  <TableRow key={model.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span>{model.name}</span>
                        {model.preview ? (
                          <Badge variant="outline" className="text-xs">
                            {t("modelsPage.badges.preview")}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className={cn(modelsTableColVisibility[1], "max-w-[26rem]")}>
                      <EndpointBadges endpoints={model.supported_endpoints} />
                    </TableCell>
                    <TableCell className={cn(modelsTableColVisibility[2], "font-mono text-xs")}>
                      {model.id}
                    </TableCell>
                    <TableCell className={cn(modelsTableColVisibility[3], "max-w-[18rem]")}>
                      <AliasBadges aliases={model.aliases} />
                    </TableCell>
                    <TableCell>
                      <ContextCell limits={model.capabilities.limits} />
                    </TableCell>
                    <TableCell>
                      <FeatureBadges supports={model.capabilities.supports} />
                    </TableCell>
                    <TableCell>
                      <MultiplierCell billing={model.billing} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
