import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import {
  Table,
  TableHead,
  TableHeader,
  TableRow,
  shouldAllowStickyHeader,
} from "../src/components/ui/table"

test("shouldAllowStickyHeader enables sticky only when requested and table fits", () => {
  expect(shouldAllowStickyHeader({ stickyHeader: true, tableWidth: 640, containerWidth: 640 })).toBe(true)
  expect(shouldAllowStickyHeader({ stickyHeader: true, tableWidth: 642, containerWidth: 640 })).toBe(false)
  expect(shouldAllowStickyHeader({ stickyHeader: false, tableWidth: 640, containerWidth: 640 })).toBe(false)
})

test("Table does not forward stickyHeader or sticky markup during static render", () => {
  const html = renderToStaticMarkup(
    <Table stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHead>Account</TableHead>
        </TableRow>
      </TableHeader>
    </Table>,
  )

  expect(html).toContain("overflow-x-auto")
  expect(html).not.toContain("stickyHeader")
  expect(html).not.toContain("data-sticky-header")
  expect(html).not.toContain("[&amp;_th]:sticky")
})
