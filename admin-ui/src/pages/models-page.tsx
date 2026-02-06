import { useCallback, useEffect, useMemo, useState } from "react"
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

const modelsTableColVisibility = [null, null, null, null, null, null] as const

type SortDir = "asc" | "desc"

type SortKey =
  | "name"
  | "endpoints"
  | "originalId"
  | "context"
  | "features"
  | "multiplier"

type SortState = { key: SortKey | null; dir: SortDir }

function fmtTokensCompact(n?: number): string {
  if (n == null) return ""
  if (!Number.isFinite(n) || n <= 0) return ""
  if (n >= 1000) return `${Math.floor(n / 1000)}K`
  return String(Math.floor(n))
}

function fmtTokensRaw(n?: number): string {
  if (n == null) return "—"
  if (!Number.isFinite(n) || n <= 0) return "—"
  return String(Math.floor(n))
}

function compareMaybeString(
  a: string | null | undefined,
  b: string | null | undefined,
  dir: SortDir,
): number {
  const aVal = a?.trim()
  const bVal = b?.trim()

  if (!aVal && !bVal) return 0
  if (!aVal) return 1
  if (!bVal) return -1

  const cmp = aVal.toLowerCase().localeCompare(bVal.toLowerCase())
  return dir === "asc" ? cmp : -cmp
}

function compareMaybeNumber(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDir,
): number {
  const aVal = typeof a === "number" && Number.isFinite(a) ? a : null
  const bVal = typeof b === "number" && Number.isFinite(b) ? b : null

  if (aVal == null && bVal == null) return 0
  if (aVal == null) return 1
  if (bVal == null) return -1

  const cmp = aVal - bVal
  if (cmp === 0) return 0
  return dir === "asc" ? cmp : -cmp
}

function makeListSortKey(values: Array<string> | null | undefined): string | null {
  if (!values || values.length === 0) return null

  const out = values
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0)
    .sort()

  return out.length > 0 ? out.join("|") : null
}

function makeFeaturesSortKey(
  supports: AdminModelDetailsItem["capabilities"]["supports"],
): string | null {
  const out: Array<string> = []

  if (supports.tool_calls) out.push("tool_calls")
  if (supports.vision) out.push("vision")
  if (supports.structured_outputs) out.push("structured_outputs")
  if (supports.streaming) out.push("streaming")
  if (supports.parallel_tool_calls) out.push("parallel_tool_calls")

  return out.length > 0 ? out.join("|") : null
}

function SortableTableHead({
  columnKey,
  label,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  columnKey: SortKey
  label: string
  sortKey: SortKey | null
  sortDir: SortDir
  onSort: (key: SortKey) => void
  className?: string
}): React.JSX.Element {
  const isActive = sortKey === columnKey

  let ariaSort: "ascending" | "descending" | "none" = "none"
  if (isActive) {
    ariaSort = sortDir === "asc" ? "ascending" : "descending"
  }

  return (
    <TableHead aria-sort={ariaSort} className={className}>
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className={cn(
          "flex w-full cursor-pointer select-none items-center gap-1 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        <span>{label}</span>
        {isActive ? <span className="text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span> : null}
      </button>
    </TableHead>
  )
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


function ContextCell({
  limits,
}: {
  limits: AdminModelDetailsItem["capabilities"]["limits"]
}): React.JSX.Element {
  const { t } = useTranslation()

  const inputCompact = fmtTokensCompact(limits.max_prompt_tokens)
  const outputCompact = fmtTokensCompact(limits.max_output_tokens)

  const tooltip = t("modelsPage.contextTooltip", {
    input: fmtTokensRaw(limits.max_prompt_tokens),
    output: fmtTokensRaw(limits.max_output_tokens),
  })

  return (
    <div
      title={tooltip}
      aria-label={tooltip}
      className="flex items-center gap-3 tabular-nums cursor-help"
    >
      <span className="text-muted-foreground">↓</span>
      <span>{inputCompact || "—"}</span>
      <span className="text-muted-foreground">↑</span>
      <span>{outputCompact || "—"}</span>
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

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<AdminModelDetailsItem[]>([])

  const [sortState, setSortState] = useState<SortState>({
    key: null,
    dir: "asc",
  })
  const { key: sortKey, dir: sortDir } = sortState

  const onSort = useCallback((key: SortKey) => {
    setSortState((prev) => {
      if (prev.key === key) {
        return { key: prev.key, dir: prev.dir === "asc" ? "desc" : "asc" }
      }

      return { key, dir: "asc" }
    })
  }, [])

  const sortedModels = useMemo(() => {
    if (!sortKey) return models

    return [...models].sort((a, b) => {
      let cmp = 0

      switch (sortKey) {
        case "name":
          cmp = compareMaybeString(a.name, b.name, sortDir)
          break
        case "endpoints":
          cmp = compareMaybeString(
            makeListSortKey(a.supported_endpoints),
            makeListSortKey(b.supported_endpoints),
            sortDir,
          )
          break
        case "originalId":
          cmp = compareMaybeString(a.id, b.id, sortDir)
          break
        case "context":
          cmp = compareMaybeNumber(
            a.capabilities.limits.max_prompt_tokens,
            b.capabilities.limits.max_prompt_tokens,
            sortDir,
          )
          if (cmp === 0) {
            cmp = compareMaybeNumber(
              a.capabilities.limits.max_output_tokens,
              b.capabilities.limits.max_output_tokens,
              sortDir,
            )
          }
          break
        case "features":
          cmp = compareMaybeString(
            makeFeaturesSortKey(a.capabilities.supports),
            makeFeaturesSortKey(b.capabilities.supports),
            sortDir,
          )
          break
        case "multiplier":
          cmp = compareMaybeNumber(a.billing?.multiplier, b.billing?.multiplier, sortDir)
          break
        default:
          cmp = 0
      }

      if (cmp !== 0) return cmp
      return a.id.localeCompare(b.id)
    })
  }, [models, sortDir, sortKey])

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
                <SortableTableHead
                  columnKey="name"
                  label={t("modelsPage.columns.name")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  columnKey="endpoints"
                  label={t("modelsPage.columns.endpoints")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  className={cn(modelsTableColVisibility[1])}
                />
                <SortableTableHead
                  columnKey="originalId"
                  label={t("modelsPage.columns.originalId")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  className={cn(modelsTableColVisibility[2])}
                />
                <SortableTableHead
                  columnKey="context"
                  label={t("modelsPage.columns.context")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  columnKey="features"
                  label={t("modelsPage.columns.features")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  columnKey="multiplier"
                  label={t("modelsPage.columns.multiplier")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && models.length === 0 && <ModelsTableSkeleton rows={10} />}
              {!loading && models.length === 0 && (
                <TableRow>
                  <TableCell colSpan={modelsTableColVisibility.length}>
                    <InlineAlert
                      variant="info"
                      title={t("modelsPage.empty.title")}
                      description={t("modelsPage.empty.description")}
                    />
                  </TableCell>
                </TableRow>
              )}
              {models.length > 0 &&
                sortedModels.map((model) => (
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
                    <TableCell className={cn(modelsTableColVisibility[2], "max-w-[26rem]")}>
                      <div className="flex flex-wrap items-center gap-1 whitespace-normal">
                        <span className="font-mono text-xs">{model.id}</span>
                        {model.aliases.map((alias) => (
                          <Badge key={alias} variant="outline" className="font-mono text-xs">
                            {alias}
                          </Badge>
                        ))}
                      </div>
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
                ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
