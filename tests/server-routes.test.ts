import { describe, expect, test } from "bun:test"

import { server } from "~/server"

describe("Server routes test", () => {
  test("server should have responses routes configured", () => {
    // Check that the server is properly configured and routes are available
    expect(server).toBeDefined()

    // The server object should have the routes configured
    // This tests that our imports and route definitions are working
    const routes = server.routes
    expect(routes).toBeDefined()
  })

  test("server should respond to root endpoint", async () => {
    const req = new Request("http://localhost/")
    const res = await server.fetch(req)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toBe("Server running")
  })
})
