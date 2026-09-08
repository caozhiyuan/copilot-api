import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { serve, type Server } from "srvx"

import { publishServerHealth } from "~/lib/server-health"

const servers: Array<Server> = []
const directories: Array<string> = []

function createServer(hostname = "127.0.0.1", manual = false): Server {
  const server = serve({
    hostname,
    port: 0,
    manual,
    silent: true,
    gracefulShutdown: false,
    fetch: () => new Response("healthy"),
  })
  servers.push(server)
  return server
}

function createHealthPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "server-health-"))
  directories.push(directory)
  return path.join(directory, "runtime", "url")
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close(true)
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("does not require a listening server when health publication is disabled", async () => {
  await publishServerHealth(createServer("127.0.0.1", true), "")
})

test("records the actual dynamically allocated port and protects the file", async () => {
  const server = createServer()
  const filePath = createHealthPath()
  await publishServerHealth(server, filePath)
  const url = fs.readFileSync(filePath, "utf8").trim()
  expect(new URL(url).port).not.toBe("0")
  expect(await (await fetch(url)).text()).toBe("healthy")
  if (process.platform !== "win32") {
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
  }
})

test.each([
  ["http://0.0.0.0:8080", "http://127.0.0.1:8080/"],
  ["http://[::]:8081", "http://[::1]:8081/"],
  ["http://127.0.0.1:8082/path?query=1", "http://127.0.0.1:8082/"],
])("normalizes %s for local probing", async (address, expected) => {
  const server = createServer()
  Object.defineProperty(server, "url", { value: address })
  const filePath = createHealthPath()
  await publishServerHealth(server, filePath)
  expect(fs.readFileSync(filePath, "utf8").trim()).toBe(expected)
})

test("rejects a server without a listening address", () => {
  expect(
    publishServerHealth(createServer("127.0.0.1", true), createHealthPath()),
  ).rejects.toThrow("Cannot determine the listening address")
})

test("closes the listener if the health state cannot be written", async () => {
  const server = createServer()
  const url = server.url!
  const filePath = createHealthPath()
  fs.writeFileSync(path.dirname(filePath), "not a directory")
  const failure = await publishServerHealth(server, filePath).catch(
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(fetch(url)).rejects.toThrow()
})
