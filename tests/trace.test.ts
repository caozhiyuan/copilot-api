import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { requestContext } from "~/lib/request-context"
import { traceIdMiddleware } from "~/lib/trace"

const createTracingApp = () => {
  const app = new Hono()

  app.use(traceIdMiddleware)

  app.get("/trace", (c) => {
    const traceId = requestContext.getStore()?.traceId ?? null
    return c.json({ traceId })
  })

  app.get("/root-session", (c) =>
    c.json({
      rootSessionId: requestContext.getStore()?.rootSessionId ?? null,
    }),
  )

  app.get("/session", (c) => {
    const context = requestContext.getStore()
    return c.json({
      rootSessionId: context?.rootSessionId ?? null,
      sessionAffinity: context?.sessionAffinity ?? null,
      subagent: context?.subagent ?? null,
    })
  })

  app.get("/trace-stream", (c) => {
    return streamSSE(c, async (stream) => {
      const traceId = requestContext.getStore()?.traceId ?? null

      await stream.writeSSE({
        event: "trace",
        data: JSON.stringify({ traceId }),
      })
    })
  })

  return app
}

describe("traceIdMiddleware", () => {
  test.each<{
    name: string
    headers: Record<string, string>
    root: string | null
    affinity: string | null
    agent?: { session_id: string; agent_id: string; agent_type: string }
  }>([
    {
      name: "Claude main session takes precedence over legacy headers",
      headers: {
        "X-Claude-Code-Session-Id": " root ",
        "session-id": "legacy",
        "x-session-affinity": "old",
      },
      root: "root",
      affinity: "root",
    },
    {
      name: "Claude child without optional gateway hint headers",
      headers: {
        "x-claude-code-session-id": "root",
        "x-claude-code-agent-id": " child ",
      },
      root: "root",
      affinity: "root:child",
      agent: {
        session_id: "root",
        agent_id: "child",
        agent_type: "claude-subagent",
      },
    },
    {
      name: "Claude nested child retains its root and current agent",
      headers: {
        "x-claude-code-session-id": "root",
        "x-claude-code-agent-id": "leaf",
        "x-claude-code-parent-agent-id": "parent",
        "x-claude-code-agent-type": "Explore",
      },
      root: "root",
      affinity: "root:leaf",
      agent: { session_id: "root", agent_id: "leaf", agent_type: "Explore" },
    },
    {
      name: "orphan Claude agent header",
      headers: { "x-claude-code-agent-id": "child" },
      root: null,
      affinity: null,
    },
    {
      name: "blank Claude agent header means main session",
      headers: {
        "x-claude-code-session-id": "root",
        "x-claude-code-agent-id": " ",
      },
      root: "root",
      affinity: "root",
    },
    {
      name: "OpenCode v1 main",
      headers: { "x-root-session-id": "root", "x-opencode-session-id": "root" },
      root: "root",
      affinity: "root",
    },
    {
      name: "OpenCode v1 child without parent header",
      headers: {
        "x-root-session-id": "root",
        "x-opencode-session-id": "child",
      },
      root: "root",
      affinity: "child",
      agent: {
        session_id: "root",
        agent_id: "child",
        agent_type: "opencode-subagent",
      },
    },
    {
      name: "OpenCode v2 native affinity",
      headers: {
        "user-agent": "opencode/latest/2.0.18/cli",
        "x-root-session-id": "root",
        "x-session-id": "child",
        "x-session-affinity": "child",
        "x-parent-session-id": "parent",
      },
      root: "root",
      affinity: "child",
      agent: {
        session_id: "root",
        agent_id: "child",
        agent_type: "opencode-subagent",
      },
    },
    {
      name: "OpenCode parent and current session without affinity header",
      headers: {
        "x-root-session-id": "root",
        "x-session-id": "child",
        "x-parent-session-id": "root",
      },
      root: "root",
      affinity: "child",
      agent: {
        session_id: "root",
        agent_id: "child",
        agent_type: "opencode-subagent",
      },
    },
    {
      name: "unrelated clients with differing grouping and request IDs",
      headers: {
        "x-root-session-id": "root",
        "x-client-request-id": "request",
      },
      root: "root",
      affinity: "request",
    },
    {
      name: "Codex child keeps the existing attribution",
      headers: {
        "session-id": "root",
        "thread-id": "child",
        "x-openai-subagent": "collab_spawn",
      },
      root: "root",
      affinity: "child",
      agent: {
        session_id: "root",
        agent_id: "child",
        agent_type: "collab_spawn",
      },
    },
    {
      name: "Codex child without a root still has its own session",
      headers: { "thread-id": "child", "x-openai-subagent": "review" },
      root: null,
      affinity: "child",
      agent: { session_id: "child", agent_id: "child", agent_type: "review" },
    },
    {
      name: "Codex missing child affinity",
      headers: { "session-id": "root", "x-openai-subagent": "review" },
      root: "root",
      affinity: null,
    },
    {
      name: "unknown Codex agent type",
      headers: { "thread-id": "child", "x-openai-subagent": "unknown" },
      root: null,
      affinity: "child",
    },
  ])(
    "derives session context for $name",
    async ({ headers, root, affinity, agent }) => {
      const response = await createTracingApp().request("/session", { headers })
      expect(await response.json()).toEqual({
        rootSessionId: root,
        sessionAffinity: affinity,
        subagent: agent ?? null,
      })
    },
  )

  test("keeps Claude sibling affinities separate while sharing the root", async () => {
    const app = createTracingApp()
    const replies = await Promise.all(
      ["a", "b", "a"].map(async (id) => {
        const response = await app.request("/session", {
          headers: {
            "x-claude-code-session-id": "root",
            "x-claude-code-agent-id": id,
          },
        })
        return response.json()
      }),
    )
    expect(replies[0]).toEqual(replies[2])
    expect(replies[0]).not.toEqual(replies[1])
  })
  test("sanitizes a valid client trace id and exposes it via request context", async () => {
    const app = createTracingApp()

    const response = await app.request("/trace", {
      headers: {
        "x-trace-id": "  trace-123_ABC  ",
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("x-trace-id")).toBe("trace-123_ABC")
    expect(await response.json()).toEqual({ traceId: "trace-123_ABC" })
  })

  test("derives the root session id from session headers, skipping blank values", async () => {
    const app = createTracingApp()

    const response = await app.request("/root-session", {
      headers: {
        "session-id": " ",
        "x-root-session-id": " root-1 ",
        "x-session-id": "leaf-1",
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rootSessionId: "root-1" })
  })

  test("falls back to a generated trace id for invalid input and preserves it in SSE", async () => {
    const app = createTracingApp()

    const response = await app.request("/trace-stream", {
      headers: {
        "x-trace-id": "bad trace value",
      },
    })

    expect(response.status).toBe(200)

    const traceId = response.headers.get("x-trace-id")

    expect(traceId).not.toBeNull()

    if (!traceId) {
      throw new Error("Expected x-trace-id response header")
    }

    expect(traceId).not.toBe("bad trace value")
    expect(traceId).toMatch(/^\w[\w.-]*$/)

    const body = await response.text()

    expect(body).toContain("event: trace")
    expect(body).toContain(`"traceId":"${traceId}"`)
  })
})
