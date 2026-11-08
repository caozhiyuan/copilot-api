import { describe, expect, mock, test } from "bun:test"

import { Hono } from "hono"
import { requestContext } from "~/lib/request-context"
import { traceIdMiddleware } from "~/lib/trace"

import * as agentContextModule from "../plugin/opencode/agent-context.js"

interface SessionInfo {
  id: string
  parentID?: string
}

interface LegacyHooks {
  event: (input: { event: unknown }) => Promise<void>
  "chat.headers": (
    input: { sessionID: string },
    output: { headers: Record<string, string> },
  ) => Promise<void>
}

type LegacyPlugin = (context?: {
  client: {
    session: {
      get: (input: { path: { id: string } }) => Promise<{ data?: SessionInfo }>
    }
  }
}) => Promise<LegacyHooks>

interface ModelRequest {
  sessionID: string
  headers: Record<string, string>
}

type ModelRequestHook = (input: ModelRequest) => Promise<void>

// Minimal contracts from the v1 Plugin/Hooks and v2 Promise plugin APIs.
const pluginModule = agentContextModule as unknown as {
  AgentContextPlugin: LegacyPlugin
  default: {
    id: string
    server: LegacyPlugin
    setup: (context: {
      session: {
        get: (input: {
          sessionID: string
        }) => Promise<SessionInfo | { data?: SessionInfo } | undefined>
        hook: (
          name: string,
          callback: ModelRequestHook,
        ) => Promise<{ dispose: () => Promise<void> }>
      }
    }) => Promise<void>
  }
}

const sessionEvent = (
  hooks: LegacyHooks,
  info: SessionInfo,
  type = "session.created",
) => hooks.event({ event: { type, properties: { info } } })

const createV2 = async (sessions: Map<string, SessionInfo>) => {
  const hooks = new Map<string, ModelRequestHook>()
  const get = mock(({ sessionID }: { sessionID: string }) =>
    Promise.resolve(sessions.get(sessionID)),
  )
  await pluginModule.default.setup({
    session: {
      get,
      hook: (name, callback) => {
        hooks.set(name, callback)
        return Promise.resolve({
          dispose: () => {
            hooks.delete(name)
            return Promise.resolve()
          },
        })
      },
    },
  })
  const request = hooks.get("model.request")
  if (!request) throw new Error("Missing model.request hook")
  return { request, get, hooks }
}

describe("OpenCode v1 session headers", () => {
  test("exposes both entrypoints without injecting chat messages", async () => {
    expect(pluginModule.default.server).toBe(pluginModule.AgentContextPlugin)
    expect(pluginModule.default.id).toBe("copilot-api.agent-context")
    const hooks = await pluginModule.default.server()
    expect("chat.message" in hooks).toBe(false)
  })

  test("sets the root session's own header", async () => {
    const hooks = await pluginModule.default.server()
    await sessionEvent(hooks, { id: "root" })
    const headers: Record<string, string> = {}
    await hooks["chat.headers"]({ sessionID: "root" }, { headers })
    expect(headers["x-root-session-id"]).toBe("root")
  })

  test("resolves four levels of parents even when creation events arrive out of order", async () => {
    const hooks = await pluginModule.default.server()
    for (const info of [
      { id: "leaf", parentID: "third" },
      { id: "third", parentID: "second" },
      { id: "second", parentID: "first" },
      { id: "first", parentID: "root" },
      { id: "root" },
    ])
      await sessionEvent(hooks, info)
    const headers: Record<string, string> = {
      "X-Session-Id": "leaf",
      "X-Root-Session-Id": "third",
      "x-root-session-id": "second",
    }
    await hooks["chat.headers"]({ sessionID: "leaf" }, { headers })
    expect(headers).toEqual({
      "X-Session-Id": "leaf",
      "x-root-session-id": "root",
    })
    expect(new Headers(headers).get("x-root-session-id")).toBe("root")
  })

  test("loads and caches restored children and ancestors through the v1 SDK", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["child", { id: "child", parentID: "parent" }],
      ["parent", { id: "parent", parentID: "root" }],
      ["root", { id: "root" }],
    ])
    const get = mock(({ path }: { path: { id: string } }) =>
      Promise.resolve({ data: sessions.get(path.id) }),
    )
    const hooks = await pluginModule.default.server({
      client: { session: { get } },
    })
    const headers: Record<string, string> = {}
    await hooks["chat.headers"]({ sessionID: "child" }, { headers })
    await hooks["chat.headers"]({ sessionID: "child" }, { headers })
    expect(headers["x-root-session-id"]).toBe("root")
    expect(get.mock.calls.map(([input]) => input.path.id)).toEqual([
      "child",
      "parent",
      "root",
    ])
  })

  test("clears deleted sessions and keeps plugin instances independent", async () => {
    const first = await pluginModule.default.server()
    const second = await pluginModule.default.server()
    await sessionEvent(first, { id: "child", parentID: "root" })
    await sessionEvent(first, { id: "root" })
    const isolated: Record<string, string> = {}
    await second["chat.headers"]({ sessionID: "child" }, { headers: isolated })
    expect(isolated).toEqual({})
    await sessionEvent(first, { id: "child" }, "session.deleted")
    const headers: Record<string, string> = { "x-session-id": "original" }
    await first["chat.headers"]({ sessionID: "child" }, { headers })
    expect(headers).toEqual({ "x-session-id": "original" })
    await sessionEvent(first, { id: "child", parentID: "other-root" })
    await sessionEvent(first, { id: "other-root" })
    await first["chat.headers"]({ sessionID: "child" }, { headers })
    expect(headers["x-root-session-id"]).toBe("other-root")
  })

  test("identifies v1 main and sibling agents through trace session information", async () => {
    const hooks = await pluginModule.default.server()
    for (const info of [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "child-b", parentID: "root" },
    ])
      await sessionEvent(hooks, info)
    const app = new Hono()
    app.use(traceIdMiddleware)
    app.get("/", (c) => {
      const context = requestContext.getStore()
      return c.json({
        root: context?.rootSessionId,
        affinity: context?.sessionAffinity,
        subagent: context?.subagent,
      })
    })
    const results = await Promise.all(
      ["root", "child-a", "child-b"].map(async (sessionID) => {
        const headers: Record<string, string> = {
          "user-agent": "opencode/1.18.0",
          "x-opencode-session-id": sessionID,
          "x-client-request-id": "shared-request",
        }
        await hooks["chat.headers"]({ sessionID }, { headers })
        return (await app.request("/", { headers })).json()
      }),
    )
    expect(results).toEqual([
      { root: "root", affinity: "root", subagent: null },
      {
        root: "root",
        affinity: "child-a",
        subagent: {
          session_id: "root",
          agent_id: "child-a",
          agent_type: "opencode-subagent",
        },
      },
      {
        root: "root",
        affinity: "child-b",
        subagent: {
          session_id: "root",
          agent_id: "child-b",
          agent_type: "opencode-subagent",
        },
      },
    ])
  })

  test("ignores malformed and unrelated events", async () => {
    const hooks = await pluginModule.default.server()
    for (const event of [
      null,
      "invalid",
      {},
      { properties: null },
      { properties: { info: null } },
      { properties: { info: {} } },
      { type: "session.updated", properties: { info: { id: "unknown" } } },
    ]) {
      await hooks.event({ event })
    }
    const headers: Record<string, string> = {}
    await hooks["chat.headers"]({ sessionID: "unknown" }, { headers })
    expect(headers).toEqual({})
  })
})

describe("OpenCode v2 root session header", () => {
  test("walks the full ancestry and preserves the native child and parent headers", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["leaf", { id: "leaf", parentID: "third" }],
      ["third", { id: "third", parentID: "second" }],
      ["second", { id: "second", parentID: "first" }],
      ["first", { id: "first", parentID: "root" }],
      ["root", { id: "root" }],
    ])
    const { request, get, hooks } = await createV2(sessions)
    const headers: Record<string, string> = {
      "X-Session-Id": "leaf",
      "X-Root-Session-Id": "old-root",
      "x-root-session-id": "another-root",
      "x-parent-session-id": "third",
      "x-session-affinity": "leaf",
      "x-opencode-session": "leaf",
      "user-agent": "opencode/latest/2.0.18/cli",
    }
    await request({ sessionID: "leaf", headers })
    expect(headers).toEqual({
      "X-Session-Id": "leaf",
      "x-root-session-id": "root",
      "x-parent-session-id": "third",
      "x-session-affinity": "leaf",
      "x-opencode-session": "leaf",
      "user-agent": "opencode/latest/2.0.18/cli",
    })
    expect(new Headers(headers).get("x-root-session-id")).toBe("root")
    expect(new Headers(headers).get("x-session-id")).toBe("leaf")
    expect(get.mock.calls.map(([input]) => input.sessionID)).toEqual([
      "leaf",
      "third",
      "second",
      "first",
      "root",
    ])
    expect([...hooks.keys()]).toEqual(["model.request"])
  })

  test("sets the ID for a root session and reads updated ancestry on later requests", async () => {
    const sessions = new Map<string, SessionInfo>([
      ["session", { id: "session" }],
    ])
    const { request } = await createV2(sessions)
    const headers: Record<string, string> = {}
    await request({ sessionID: "session", headers })
    expect(headers["x-root-session-id"]).toBe("session")

    sessions.set("session", { id: "session", parentID: "root" })
    sessions.set("root", { id: "root" })
    await request({ sessionID: "session", headers })
    expect(headers["x-root-session-id"]).toBe("root")
  })

  test("also accepts SDK-style wrapped session responses", async () => {
    let request: ModelRequestHook | undefined
    const sessions = new Map<string, SessionInfo>([
      ["child", { id: "child", parentID: "root" }],
      ["root", { id: "root" }],
    ])
    await pluginModule.default.setup({
      session: {
        get: ({ sessionID }) =>
          Promise.resolve({ data: sessions.get(sessionID) }),
        hook: (_name, callback) => {
          request = callback
          return Promise.resolve({ dispose: () => Promise.resolve() })
        },
      },
    })
    if (!request) throw new Error("Missing model.request hook")
    const headers: Record<string, string> = { "x-session-id": "child" }
    await request({ sessionID: "child", headers })
    expect(headers).toEqual({
      "x-session-id": "child",
      "x-root-session-id": "root",
    })
  })

  test.each([
    new Map<string, SessionInfo>(),
    new Map<string, SessionInfo>([
      ["child", { id: "child", parentID: "missing" }],
    ]),
    new Map<string, SessionInfo>([["child", { id: "different-session" }]]),
    new Map<string, SessionInfo>([
      ["child", { id: "child", parentID: "child" }],
    ]),
    new Map<string, SessionInfo>([
      ["child", { id: "child", parentID: "parent" }],
      ["parent", { id: "parent", parentID: "child" }],
    ]),
  ])(
    "keeps existing headers when ancestry is missing or cyclic (%#)",
    async (sessions) => {
      const { request } = await createV2(sessions)
      const headers = {
        "X-Session-Id": "child",
        "x-parent-session-id": "parent",
      }
      await request({ sessionID: "child", headers })
      expect(headers).toEqual({
        "X-Session-Id": "child",
        "x-parent-session-id": "parent",
      })
    },
  )

  test("keeps model requests working when a session lookup fails", async () => {
    let request: ModelRequestHook | undefined
    await pluginModule.default.setup({
      session: {
        get: () => Promise.reject(new Error("Session not found")),
        hook: (_name, callback) => {
          request = callback
          return Promise.resolve({ dispose: () => Promise.resolve() })
        },
      },
    })
    if (!request) throw new Error("Missing model.request hook")
    const headers = { "x-session-id": "child" }
    await request({ sessionID: "child", headers })
    expect(headers["x-session-id"]).toBe("child")
  })
})
