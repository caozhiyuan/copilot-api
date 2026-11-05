/** Opt-in adapter for NEW Copilot V2 histories; old ciphertext stays fail-closed. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }
export const PLAINTEXT_V2_ALIAS = "capi_plaintext_v2"
const messageTools = new Set(["spawn_agent", "send_message", "followup_task"])
const object = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v)
const fieldText = (value: Json | undefined): string =>
  typeof value === "string" ? value : ""
const opaque = (s: string) =>
  /^(gAAAA[A-Za-z0-9_-]{30,}|UlQC[A-Za-z0-9_-]{30,})/.test(s)

function catalogs(p: Obj): Json[][] {
  const out: Json[][] = []
  if (Array.isArray(p.tools)) out.push(p.tools)
  if (Array.isArray(p.input))
    for (const item of p.input) {
      if (
        object(item)
        && ["additional_tools", "tool_search_output"].includes(
          fieldText(item.type),
        )
        && Array.isArray(item.tools)
      )
        out.push(item.tools)
    }
  return out
}

function namespaces(tools: Json[], visit: (tool: Obj) => void): void {
  for (const tool of tools)
    if (object(tool)) {
      visit(tool)
      if (Array.isArray(tool.tools)) namespaces(tool.tools, visit)
    }
}

export function preparePlaintextV2<T>(
  payload: T,
  models = "",
): { payload: T; active: boolean; error?: string } {
  const off = { payload, active: false }
  if (
    !object(payload)
    || !models
      .split(",")
      .map((s) => s.trim())
      .includes(fieldText(payload.model))
  )
    return off
  const p = structuredClone(payload) as Obj
  let declared = false
  let conflict = false
  for (const list of catalogs(p))
    namespaces(list, (tool) => {
      if (tool.type === "namespace" && tool.name === "collaboration")
        declared = true
      if (
        tool.name === PLAINTEXT_V2_ALIAS
        || tool.namespace === PLAINTEXT_V2_ALIAS
      )
        conflict = true
    })
  if (conflict)
    return {
      ...off,
      error: "Plaintext V2 namespace collision; request was not forwarded.",
    }
  if (Array.isArray(p.input))
    for (const item of p.input)
      if (object(item)) {
        if (
          item.type === "agent_message"
          && Array.isArray(item.content)
          && item.content.some(
            (b) => object(b) && b.type === "encrypted_content",
          )
        )
          return {
            ...off,
            error:
              "Plaintext V2 accepts new plaintext histories only; existing encrypted agent messages are not decrypted or discarded.",
          }
        if (
          item.type === "function_call"
          && item.namespace === "collaboration"
          && messageTools.has(fieldText(item.name))
        ) {
          if (
            Array.isArray(item.encrypted_function_args)
            && item.encrypted_function_args.length > 0
          )
            return {
              ...off,
              error:
                "Encrypted historical collaboration arguments cannot be relabeled plaintext.",
            }
          if (typeof item.arguments !== "string") continue
          let args: unknown
          try {
            args = JSON.parse(item.arguments)
          } catch {
            return {
              ...off,
              error: "Invalid historical collaboration arguments.",
            }
          }
          if (
            object(args)
            && typeof args.message === "string"
            && opaque(args.message)
          )
            return {
              ...off,
              error:
                "Opaque historical collaboration arguments cannot be relabeled plaintext.",
            }
        }
      }
  if (!declared) return off
  for (const list of catalogs(p))
    namespaces(list, (tool) => {
      if (tool.type !== "namespace" || tool.name !== "collaboration") return
      tool.name = PLAINTEXT_V2_ALIAS
      if (Array.isArray(tool.tools))
        for (const fn of tool.tools)
          if (
            object(fn)
            && messageTools.has(fieldText(fn.name))
            && object(fn.parameters)
            && object(fn.parameters.properties)
            && object(fn.parameters.properties.message)
          )
            delete fn.parameters.properties.message.encrypted
    })
  if (Array.isArray(p.input))
    for (const item of p.input)
      if (
        object(item)
        && item.type === "function_call"
        && item.namespace === "collaboration"
      )
        item.namespace = PLAINTEXT_V2_ALIAS
  if (object(p.tool_choice) && p.tool_choice.namespace === "collaboration")
    p.tool_choice.namespace = PLAINTEXT_V2_ALIAS
  return { payload: p as T, active: true }
}

export function restorePlaintextV2Response<T>(value: T, active: boolean): T {
  if (!active) return value
  const result = structuredClone(value)
  const visit = (node: unknown, incomplete = false): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, incomplete))
      return
    }
    if (!object(node)) return
    const partial =
      node.type === "function_call" && node.status === "completed" ?
        false
      : incomplete
        || node.status === "incomplete"
        || node.type === "response.incomplete"
    if (
      node.type === "function_call"
      && node.namespace === PLAINTEXT_V2_ALIAS
    ) {
      node.namespace = "collaboration"
      if (messageTools.has(fieldText(node.name))) {
        if (
          Array.isArray(node.encrypted_function_args)
          && node.encrypted_function_args.length > 0
        )
          throw new Error("Upstream returned encrypted collaboration arguments")
        if (!partial && typeof node.arguments === "string" && node.arguments) {
          const args: unknown = JSON.parse(node.arguments)
          if (
            !object(args)
            || typeof args.message !== "string"
            || !args.message.trim()
            || opaque(args.message)
          )
            throw new Error(
              "Upstream did not return valid plaintext collaboration arguments",
            )
        }
        if (!partial) node.encrypted_function_args = []
      }
    }
    if (Array.isArray(node.tools))
      namespaces(node.tools, (tool) => {
        if (tool.type === "namespace" && tool.name === PLAINTEXT_V2_ALIAS)
          tool.name = "collaboration"
        if (tool.namespace === PLAINTEXT_V2_ALIAS)
          tool.namespace = "collaboration"
      })
    if (
      object(node.tool_choice)
      && node.tool_choice.namespace === PLAINTEXT_V2_ALIAS
    )
      node.tool_choice.namespace = "collaboration"
    // Never descend into user text, tool arguments, or tool-result bodies.
    for (const key of ["item", "response", "output"])
      if (
        key in node
        && !["function_call_output", "custom_tool_call_output"].includes(
          fieldText(node.type),
        )
      )
        visit(node[key], partial)
  }
  visit(result)
  return result
}

export function restorePlaintextV2Chunk<T>(chunk: T, active: boolean): T {
  if (
    !active
    || !object(chunk)
    || typeof chunk.data !== "string"
    || !chunk.data.startsWith("{")
  )
    return chunk
  const event: unknown = JSON.parse(chunk.data)
  return {
    ...chunk,
    data: JSON.stringify(restorePlaintextV2Response(event, true)),
  }
}
