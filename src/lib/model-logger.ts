import type { MiddlewareHandler } from "hono"

import { getColorEnabled } from "hono/utils/color"

const humanize = (times: Array<string>): string => {
  const [delimiter, separator] = [",", "."]
  const orderTimes = times.map((v) =>
    v.replaceAll(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1" + delimiter),
  )
  return orderTimes.join(separator)
}

const elapsed = (start: number): string => {
  const delta = Date.now() - start
  return humanize([
    delta < 1000 ? `${delta}ms` : `${Math.round(delta / 1000)}s`,
  ])
}

const colorStatus = (status: number): string => {
  if (!getColorEnabled()) return `${status}`
  switch (Math.trunc(status / 100)) {
    case 5: {
      return `\x1b[31m${status}\x1b[0m`
    }
    case 4: {
      return `\x1b[33m${status}\x1b[0m`
    }
    case 3: {
      return `\x1b[36m${status}\x1b[0m`
    }
    case 2: {
      return `\x1b[32m${status}\x1b[0m`
    }
    default: {
      return `${status}`
    }
  }
}

const formatModelBadge = (model: string): string => {
  if (!getColorEnabled()) return ` [${model}]`
  return ` \x1b[100m\x1b[1m\x1b[97m [${model}] \x1b[0m`
}

const extractModelFromBody = async (
  req: Request,
): Promise<string | undefined> => {
  const contentType = req.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return undefined

  try {
    const body = (await req.clone().json()) as Record<string, unknown>
    const model = body["model"]
    return typeof model === "string" && model ? model : undefined
  } catch {
    return undefined
  }
}

export const modelAwareLogger: MiddlewareHandler = async (c, next) => {
  const { method } = c.req
  const { url } = c.req
  const path = url.slice(url.indexOf("/", 8))

  let incomingLine = `<-- ${method} ${path}`

  if (method === "POST") {
    const model = await extractModelFromBody(c.req.raw)
    if (model) {
      incomingLine += formatModelBadge(model)
    }
  }

  console.log(incomingLine)

  const start = Date.now()
  await next()

  console.log(
    `--> ${method} ${path} ${colorStatus(c.res.status)} ${elapsed(start)}`,
  )
}
