import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { LoaderCircleIcon, RefreshCwIcon, SearchIcon } from "lucide-react"

import {
  AdminApiError,
  type AdminModelDetailsItem,
  getAdminModelDetails,
} from "@/lib/admin-api"
import { i18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const modelsTableColVisibility = [
  null,
  "hidden lg:table-cell",
  "hidden lg:table-cell",
  null,
  null,
  null,
] as const

const MODELS_COL_COUNT = modelsTableColVisibility.length

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
  tooltip,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  columnKey: SortKey
  label: string
  tooltip?: string
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
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onSort(columnKey)}
              className={cn(
                "flex w-full cursor-pointer select-none items-center gap-1 text-left",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              )}
            >
              <span className="cursor-help underline decoration-dashed decoration-current/30 underline-offset-2">
                {label}
              </span>
              {isActive ? (
                <span className="text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>
              ) : null}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      ) : (
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
      )}
    </TableHead>
  )
}

function ModelsTableSkeleton({ rows }: { rows: number }): React.JSX.Element {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: MODELS_COL_COUNT }).map((__, j) => (
            <TableCell
              key={j}
              className={cn("py-3", modelsTableColVisibility[j])}
            >
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

  const features: Array<{ key: string; label: string; tooltip: string }> = []

  if (supports.tool_calls) {
    features.push({ key: "tool_calls", label: t("modelsPage.features.tools"), tooltip: t("modelsPage.featureTooltip.tools") })
  }

  if (supports.vision) {
    features.push({ key: "vision", label: t("modelsPage.features.vision"), tooltip: t("modelsPage.featureTooltip.vision") })
  }

  if (supports.structured_outputs) {
    features.push({
      key: "structured_outputs",
      label: t("modelsPage.features.structuredOutputs"),
      tooltip: t("modelsPage.featureTooltip.structuredOutputs"),
    })
  }

  if (supports.streaming) {
    features.push({ key: "streaming", label: t("modelsPage.features.streaming"), tooltip: t("modelsPage.featureTooltip.streaming") })
  }

  if (supports.parallel_tool_calls) {
    features.push({
      key: "parallel_tool_calls",
      label: t("modelsPage.features.parallelTools"),
      tooltip: t("modelsPage.featureTooltip.parallelTools"),
    })
  }

  if (features.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <div className="flex flex-wrap gap-1 whitespace-normal">
      {features.map((f) => (
        <Tooltip key={f.key}>
          <TooltipTrigger asChild>
            <button type="button" className="focus-visible:outline-none">
              <Badge variant="outline" className="cursor-help text-xs">
                {f.label}
              </Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-60">
            <p>{f.tooltip}</p>
          </TooltipContent>
        </Tooltip>
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

  const tooltipText = t("modelsPage.contextTooltip", {
    input: fmtTokensRaw(limits.max_prompt_tokens),
    output: fmtTokensRaw(limits.max_output_tokens),
  })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex cursor-help items-center gap-3 tabular-nums focus-visible:outline-none"
        >
          <span className="text-muted-foreground text-xs">{t("modelsPage.contextInputLabel")}</span>
          <span>{inputCompact || "—"}</span>
          <span className="text-muted-foreground text-xs">{t("modelsPage.contextOutputLabel")}</span>
          <span>{outputCompact || "—"}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        <p>{tooltipText}</p>
      </TooltipContent>
    </Tooltip>
  )
}

const ALIAS_COLLAPSE_THRESHOLD = 3

function AliasesCell({
  id,
  aliases,
}: {
  id: string
  aliases: Array<string>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const visible = expanded ? aliases : aliases.slice(0, ALIAS_COLLAPSE_THRESHOLD)
  const hiddenCount = aliases.length - ALIAS_COLLAPSE_THRESHOLD

  return (
    <div className="flex flex-wrap items-center gap-1 whitespace-normal">
      <span className="max-w-[14rem] truncate font-mono text-xs" title={id}>{id}</span>
      {visible.map((alias) => (
        <Badge key={alias} variant="outline" className="max-w-[10rem] truncate font-mono text-xs" title={alias}>
          {alias}
        </Badge>
      ))}
      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-muted-foreground hover:text-foreground cursor-pointer text-xs transition-colors"
        >
          {t("modelsPage.aliasesMore", { count: hiddenCount })}
        </button>
      )}
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

type FilterTag = "premium" | "preview"

export function ModelsPage(): React.JSX.Element {
  const { t } = useTranslation()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<AdminModelDetailsItem[]>([])

  const [search, setSearch] = useState("")
  const [activeFilters, setActiveFilters] = useState<Set<FilterTag>>(new Set())

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

  const toggleFilter = useCallback((tag: FilterTag) => {
    setActiveFilters((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) {
        next.delete(tag)
      } else {
        next.add(tag)
      }
      return next
    })
  }, [])

  const stats = useMemo(() => {
    let premium = 0
    let preview = 0
    for (const m of models) {
      if (m.billing?.is_premium) premium++
      if (m.preview) preview++
    }
    return { total: models.length, premium, preview }
  }, [models])

  const filteredModels = useMemo(() => {
    let result = models

    const q = search.trim().toLowerCase()
    if (q) {
      result = result.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.aliases.some((a) => a.toLowerCase().includes(q)),
      )
    }

    if (activeFilters.has("premium")) {
      result = result.filter((m) => m.billing?.is_premium)
    }
    if (activeFilters.has("preview")) {
      result = result.filter((m) => m.preview)
    }

    return result
  }, [models, search, activeFilters])

  const sortedModels = useMemo(() => {
    if (!sortKey) return filteredModels

    return [...filteredModels].sort((a, b) => {
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
  }, [filteredModels, sortDir, sortKey])

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
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>{t("modelsPage.title")}</CardTitle>
              <CardDescription>{t("modelsPage.description")}</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? (
                <LoaderCircleIcon className="size-4 motion-safe:animate-spin" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
              {t("common.refresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative max-w-64 flex-1">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("modelsPage.searchPlaceholder")}
                aria-label={t("modelsPage.searchAriaLabel")}
                className="pl-8"
              />
            </div>
            <Badge
              asChild
              variant={activeFilters.has("premium") ? "default" : "outline"}
            >
              <button
                type="button"
                aria-pressed={activeFilters.has("premium")}
                className="cursor-pointer select-none transition-colors"
                onClick={() => toggleFilter("premium")}
              >
                {t("modelsPage.badges.premium")}
                {stats.premium > 0 ? ` (${stats.premium})` : ""}
              </button>
            </Badge>
            <Badge
              asChild
              variant={activeFilters.has("preview") ? "default" : "outline"}
            >
              <button
                type="button"
                aria-pressed={activeFilters.has("preview")}
                className="cursor-pointer select-none transition-colors"
                onClick={() => toggleFilter("preview")}
              >
                {t("modelsPage.badges.preview")}
                {stats.preview > 0 ? ` (${stats.preview})` : ""}
              </button>
            </Badge>
            <span className={cn(
              "text-muted-foreground ml-auto text-sm tabular-nums",
              !loading && models.length > 0 && "motion-safe:animate-in motion-safe:fade-in-0",
            )}>
              {filteredModels.length === stats.total
                ? t("modelsPage.totalCount", { count: stats.total })
                : t("modelsPage.filteredCount", { filtered: filteredModels.length, total: stats.total })}
            </span>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  columnKey="name"
                  label={t("modelsPage.columns.name")}
                  tooltip={t("modelsPage.columnTooltip.name")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  columnKey="endpoints"
                  label={t("modelsPage.columns.endpoints")}
                  tooltip={t("modelsPage.columnTooltip.endpoints")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  className={modelsTableColVisibility[1]}
                />
                <SortableTableHead
                  columnKey="originalId"
                  label={t("modelsPage.columns.originalId")}
                  tooltip={t("modelsPage.columnTooltip.originalId")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                  className={modelsTableColVisibility[2]}
                />
                <SortableTableHead
                  columnKey="context"
                  label={t("modelsPage.columns.context")}
                  tooltip={t("modelsPage.columnTooltip.context")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  columnKey="features"
                  label={t("modelsPage.columns.features")}
                  tooltip={t("modelsPage.columnTooltip.features")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
                <SortableTableHead
                  columnKey="multiplier"
                  label={t("modelsPage.columns.multiplier")}
                  tooltip={t("modelsPage.columnTooltip.multiplier")}
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onSort={onSort}
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && models.length === 0 && <ModelsTableSkeleton rows={10} />}
              {!loading && filteredModels.length === 0 && (
                <TableRow>
                  <TableCell colSpan={MODELS_COL_COUNT}>
                    <InlineAlert
                      variant="info"
                      title={t("modelsPage.empty.title")}
                      description={
                        models.length > 0
                          ? t("modelsPage.empty.noMatchesDescription")
                          : t("modelsPage.empty.description")
                      }
                    />
                  </TableCell>
                </TableRow>
              )}
              {filteredModels.length > 0 &&
                sortedModels.map((model, idx) => (
                  <TableRow
                    key={model.id}
                    className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 fill-mode-backwards"
                    style={{ animationDelay: `${Math.min(idx * 30, 600)}ms`, animationDuration: "300ms" }}
                  >
                    <TableCell className="max-w-[16rem]">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate" title={model.name}>{model.name}</span>
                        {model.preview ? (
                          <Badge variant="outline" className="shrink-0 text-xs">
                            {t("modelsPage.badges.preview")}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className={cn("max-w-[26rem]", modelsTableColVisibility[1])}>
                      <EndpointBadges endpoints={model.supported_endpoints} />
                    </TableCell>
                    <TableCell className={cn("max-w-[26rem]", modelsTableColVisibility[2])}>
                      <AliasesCell id={model.id} aliases={model.aliases} />
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
