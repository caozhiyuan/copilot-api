import type { MiddlewareHandler } from "hono"

import { getColorEnabled } from "hono/utils/color"
import { AsyncLocalStorage } from "node:async_hooks"

interface PendingLog {
  print: (model?: string) => void
  printed: boolean
}

const pendingLogStorage = new AsyncLocalStorage<PendingLog>()

const humanize = (times: Array<string>): string => {
  const [delimiter, separator] = [",", "."]
  const orderTimes = times.map((v) =>
    v.replaceAll(/(\d)(?=(\d\d\d)+(?!\d))/g, `$1${delimiter}`),
  )
  return orderTimes.join(separator)
}

const calcElapsed = (start: number): string => {
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

/**
 * Call this in a request handler once the model name is known.
 * It flushes the deferred "<-- METHOD PATH [model]" log line.
 * If never called, the middleware will print the line without a model badge.
 */
export const logRequestModel = (model: string): void => {
  const store = pendingLogStorage.getStore()
  if (!store || store.printed) return
  store.printed = true
  store.print(model)
}

export const modelAwareLogger: MiddlewareHandler = async (c, next) => {
  const { method } = c.req
  const { url } = c.req
  const path = url.slice(url.indexOf("/", 8))

  const pending: PendingLog = {
    printed: false,
    print: (model?: string) => {
      const badge = model ? formatModelBadge(model) : ""
      console.log(`<-- ${method} ${path}${badge}`)
    },
  }

  const start = Date.now()

  await pendingLogStorage.run(pending, async () => {
    await next()
  })

  if (!pending.printed) {
    pending.print()
  }

  console.log(
    `--> ${method} ${path} ${colorStatus(c.res.status)} ${calcElapsed(start)}`,
  )
}
