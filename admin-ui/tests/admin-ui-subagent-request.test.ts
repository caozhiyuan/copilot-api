import { expect, test } from "bun:test"

import { normalizeAdminRequestItem } from "../src/lib/admin-api"

test("normalizeAdminRequestItem converts wire is_subagent values into UI semantics", () => {
  expect(normalizeAdminRequestItem({ request_id: "r1", http_status: 200, path: "/v1/messages", is_subagent: 1 }).is_subagent).toBe(true)
  expect(normalizeAdminRequestItem({ request_id: "r2", http_status: 200, path: "/v1/messages", is_subagent: 0 }).is_subagent).toBe(false)
  expect(normalizeAdminRequestItem({ request_id: "r3", http_status: 200, path: "/v1/messages", is_subagent: null }).is_subagent).toBeNull()
  expect(normalizeAdminRequestItem({ request_id: "r4", http_status: 200, path: "/v1/messages" }).is_subagent).toBeNull()
})
