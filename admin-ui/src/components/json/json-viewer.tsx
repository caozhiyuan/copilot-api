import * as React from "react"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { fmtLocalDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

export interface JsonViewerProps {
  value: unknown
  search?: string
  defaultExpandedDepth?: number
  className?: string
}

const MAX_ITEMS_PER_NODE = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function highlight(text: string, query: string | undefined): React.ReactNode {
  const q = query?.trim()
  if (!q) return text

  const lower = text.toLowerCase()
  const needle = q.toLowerCase()

  const parts: React.ReactNode[] = []
  let i = 0

  while (i < text.length) {
    const idx = lower.indexOf(needle, i)
    if (idx === -1) {
      parts.push(text.slice(i))
      break
    }

    if (idx > i) parts.push(text.slice(i, idx))

    parts.push(
      <mark
        key={`${idx}-${needle}`}
        className="bg-accent/50 text-foreground rounded px-0.5"
      >
        {text.slice(idx, idx + needle.length)}
      </mark>
    )

    i = idx + needle.length
  }

  return <>{parts}</>
}

function formatPrimitive(
  value: unknown,
  search: string | undefined,
  name: string | undefined
): React.ReactNode {
  if (value == null) return <span className="text-muted-foreground">null</span>

  if (typeof value === "string") {
    return (
      <span className="text-foreground">
        &quot;{highlight(value, search)}&quot;
      </span>
    )
  }

  if (typeof value === "number") {
    const raw = String(value)

    if (!name || !/_at_ms$/.test(name)) {
      return <span className="text-foreground">{raw}</span>
    }

    const local = fmtLocalDateTime(value)
    if (!local) return <span className="text-foreground">{raw}</span>

    return (
      <>
        <span className="text-foreground" title={local}>
          {raw}
        </span>
        <span className="text-muted-foreground ml-1">
          ({highlight(local, search)})
        </span>
      </>
    )
  }

  if (typeof value === "boolean") {
    return <span className="text-foreground">{value ? "true" : "false"}</span>
  }

  return <span className="text-foreground">{String(value)}</span>
}

function NodeRow({
  depth,
  name,
  valuePreview,
  expanded,
  toggle,
}: {
  depth: number
  name?: React.ReactNode
  valuePreview: React.ReactNode
  expanded: boolean
  toggle?: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex items-start gap-2"
      style={{ paddingLeft: depth * 12 }}
    >
      {toggle ? (
        <button
          type="button"
          onClick={toggle}
          className="text-muted-foreground hover:text-foreground mt-0.5"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )}
        </button>
      ) : (
        <span className="size-4" />
      )}

      {name ? (
        <>
          <span className="text-muted-foreground">{name}</span>
          <span className="text-muted-foreground">:</span>
        </>
      ) : (
        <span className="text-muted-foreground">(root)</span>
      )}

      <span className="min-w-0 break-words">{valuePreview}</span>
    </div>
  )
}

function JsonNode({
  value,
  name,
  path,
  depth,
  search,
  baseExpandDepth,
  expandedPaths,
  collapsedPaths,
  onToggle,
}: {
  value: unknown
  name?: string
  path: string
  depth: number
  search: string | undefined
  baseExpandDepth: number
  expandedPaths: Set<string>
  collapsedPaths: Set<string>
  onToggle: (path: string, nextExpanded: boolean) => void
}): React.JSX.Element {
  const isObj = isRecord(value)
  const isArr = Array.isArray(value)

  const isContainer = isObj || isArr

  const expanded =
    isContainer &&
    (collapsedPaths.has(path)
      ? false
      : expandedPaths.has(path)
        ? true
        : depth < baseExpandDepth)

  if (!isContainer) {
    return (
      <NodeRow
        depth={depth}
        name={name ? highlight(name, search) : undefined}
        valuePreview={formatPrimitive(value, search, name)}
        expanded={false}
      />
    )
  }

  const count = isArr ? value.length : Object.keys(value).length
  const label = isArr ? `Array(${count})` : `Object(${count})`

  return (
    <div className="space-y-1">
      <NodeRow
        depth={depth}
        name={name ? highlight(name, search) : undefined}
        valuePreview={<span className="text-muted-foreground">{label}</span>}
        expanded={expanded}
        toggle={() => onToggle(path, !expanded)}
      />

      {expanded ? (
        <div className="space-y-1">
          {isArr
            ? value
                .slice(0, MAX_ITEMS_PER_NODE)
                .map((child, idx) => (
                  <JsonNode
                    key={`${path}[${idx}]`}
                    value={child}
                    name={`[${idx}]`}
                    path={`${path}[${idx}]`}
                    depth={depth + 1}
                    search={search}
                    baseExpandDepth={baseExpandDepth}
                    expandedPaths={expandedPaths}
                    collapsedPaths={collapsedPaths}
                    onToggle={onToggle}
                  />
                ))
            : Object.entries(value)
                .slice(0, MAX_ITEMS_PER_NODE)
                .map(([k, child]) => (
                  <JsonNode
                    key={`${path}.${k}`}
                    value={child}
                    name={k}
                    path={`${path}.${k}`}
                    depth={depth + 1}
                    search={search}
                    baseExpandDepth={baseExpandDepth}
                    expandedPaths={expandedPaths}
                    collapsedPaths={collapsedPaths}
                    onToggle={onToggle}
                  />
                ))}

          {count > MAX_ITEMS_PER_NODE ? (
            <NodeRow
              depth={depth + 1}
              valuePreview={
                <span className="text-muted-foreground">
                  … {count - MAX_ITEMS_PER_NODE} more
                </span>
              }
              expanded={false}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function JsonViewer({
  value,
  search,
  defaultExpandedDepth = 2,
  className,
}: JsonViewerProps): React.JSX.Element {
  const [baseExpandDepth, setBaseExpandDepth] = React.useState(defaultExpandedDepth)
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(() => new Set())
  const [collapsedPaths, setCollapsedPaths] = React.useState<Set<string>>(() => new Set())

  function toggle(path: string, nextExpanded: boolean): void {
    if (nextExpanded) {
      setCollapsedPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      setExpandedPaths((prev) => {
        const next = new Set(prev)
        next.add(path)
        return next
      })
      return
    }

    setExpandedPaths((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
    setCollapsedPaths((prev) => {
      const next = new Set(prev)
      next.add(path)
      return next
    })
  }

  function expandAll(): void {
    setBaseExpandDepth(99)
    setCollapsedPaths(new Set())
    setExpandedPaths(new Set())
  }

  function collapseAll(): void {
    setBaseExpandDepth(0)
    setExpandedPaths(new Set())
    setCollapsedPaths(new Set())
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={expandAll}>
          Expand all
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={collapseAll}>
          Collapse all
        </Button>
        <span className="text-muted-foreground ml-auto text-xs">
          {baseExpandDepth === 0
            ? "collapsed"
            : baseExpandDepth >= 99
              ? "expanded"
              : `depth<${baseExpandDepth}`}
        </span>
      </div>

      <div className="bg-muted/20 overflow-auto rounded-md border p-3 font-mono text-xs">
        <JsonNode
          value={value}
          path="$"
          depth={0}
          search={search}
          baseExpandDepth={baseExpandDepth}
          expandedPaths={expandedPaths}
          collapsedPaths={collapsedPaths}
          onToggle={toggle}
        />
      </div>
    </div>
  )
}
