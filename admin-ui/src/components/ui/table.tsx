import * as React from "react"
import { useCallback } from "react"

import { cn } from "@/lib/utils"

const TableStickyHeaderContext = React.createContext(false)
const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function shouldAllowStickyHeader({
  stickyHeader,
  tableWidth,
  containerWidth,
}: {
  stickyHeader?: boolean
  tableWidth: number
  containerWidth: number
}) {
  return Boolean(stickyHeader) && tableWidth <= containerWidth + 1
}

function Table({
  className,
  glow,
  stickyHeader,
  ...props
}: React.ComponentProps<"table"> & { glow?: boolean; stickyHeader?: boolean }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const tableRef = React.useRef<HTMLTableElement | null>(null)
  const [allowStickyHeader, setAllowStickyHeader] = React.useState(false)

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLTableElement>) => {
      if (!glow) return
      const row = (e.target as HTMLElement).closest("tr")
      if (!row) return
      const rect = row.getBoundingClientRect()
      row.style.setProperty("--glow-x", `${e.clientX - rect.left}px`)
      row.style.setProperty("--glow-y", `${e.clientY - rect.top}px`)
    },
    [glow],
  )

  useIsomorphicLayoutEffect(() => {
    if (!stickyHeader) {
      setAllowStickyHeader(false)
      return
    }

    const container = containerRef.current
    const table = tableRef.current
    if (!container || !table) return

    const syncStickyHeader = () => {
      setAllowStickyHeader(
        shouldAllowStickyHeader({
          stickyHeader,
          tableWidth: table.scrollWidth,
          containerWidth: container.clientWidth,
        }),
      )
    }

    syncStickyHeader()
    window.addEventListener("resize", syncStickyHeader)

    if (typeof ResizeObserver === "undefined") {
      return () => {
        window.removeEventListener("resize", syncStickyHeader)
      }
    }

    const resizeObserver = new ResizeObserver(syncStickyHeader)
    resizeObserver.observe(container)
    resizeObserver.observe(table)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener("resize", syncStickyHeader)
    }
  }, [stickyHeader])

  return (
    <div
      ref={containerRef}
      data-slot="table-container"
      data-sticky-header={allowStickyHeader ? "" : undefined}
      className={cn("relative w-full", allowStickyHeader ? "overflow-x-visible" : "overflow-x-auto")}
    >
      <TableStickyHeaderContext.Provider value={allowStickyHeader}>
        <table
          ref={tableRef}
          data-slot="table"
          data-glow-table={glow ? "" : undefined}
          className={cn("w-full caption-bottom text-sm", className)}
          onMouseMove={glow ? onMouseMove : undefined}
          {...props}
        />
      </TableStickyHeaderContext.Provider>
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  const stickyHeader = React.useContext(TableStickyHeaderContext)

  return (
    <thead
      data-slot="table-header"
      data-sticky-header={stickyHeader ? "" : undefined}
      className={cn(
        "[&_tr]:border-b",
        stickyHeader && "[&_th]:sticky [&_th]:top-[var(--app-shell-header-height,3.5rem)] [&_th]:z-20 [&_th]:border-b [&_th]:border-border [&_th]:bg-card",
        className,
      )}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "bg-muted/50 border-t font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "text-foreground h-10 px-2 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("text-muted-foreground mt-4 text-sm", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  shouldAllowStickyHeader,
}
