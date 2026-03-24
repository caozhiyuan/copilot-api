import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

const AGENT_OPTIONS: Agent.Options = {
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: {
    timeout: 15_000,
  },
}

let directAgent: Agent | null = null
let proxyMode = false
let proxies: Map<string, ProxyAgent> | null = null

function isBun(): boolean {
  return typeof Bun !== "undefined"
}

function createDispatcher(
  direct: Agent,
  proxyMap: Map<string, ProxyAgent>,
): object {
  return {
    dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ) {
      try {
        const origin =
          typeof options.origin === "string" ?
            new URL(options.origin)
          : (options.origin as URL)
        const get = getProxyForUrl as unknown as (
          u: string,
        ) => string | undefined
        const raw = get(origin.toString())
        const proxyUrl = raw && raw.length > 0 ? raw : undefined
        if (!proxyUrl) {
          consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
          return (direct as unknown as Dispatcher).dispatch(options, handler)
        }
        let agent = proxyMap.get(proxyUrl)
        if (!agent) {
          agent = new ProxyAgent(proxyUrl)
          proxyMap.set(proxyUrl, agent)
        }
        let label = proxyUrl
        try {
          const u = new URL(proxyUrl)
          label = `${u.protocol}//${u.host}`
        } catch {
          /* noop */
        }
        consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
        return (agent as unknown as Dispatcher).dispatch(options, handler)
      } catch {
        return (direct as unknown as Dispatcher).dispatch(options, handler)
      }
    },
    close() {
      return direct.close()
    },
    destroy() {
      return direct.destroy()
    },
  }
}

export function initDefaultAgent(): void {
  if (isBun()) return

  directAgent = new Agent(AGENT_OPTIONS)
  setGlobalDispatcher(directAgent as unknown as Dispatcher)
  consola.debug("Default HTTP agent configured with keep-alive timeouts")
}

export function initProxyFromEnv(): void {
  if (isBun()) return

  try {
    directAgent = new Agent(AGENT_OPTIONS)
    proxies = new Map<string, ProxyAgent>()
    proxyMode = true

    const dispatcher = createDispatcher(directAgent, proxies)

    setGlobalDispatcher(dispatcher as unknown as Dispatcher)
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}

export function resetAgent(): void {
  if (isBun()) return

  const oldAgent = directAgent
  if (oldAgent) {
    oldAgent.close().catch(() => {})
  }

  directAgent = new Agent(AGENT_OPTIONS)

  if (proxyMode) {
    proxies = new Map<string, ProxyAgent>()
    const dispatcher = createDispatcher(directAgent, proxies)
    setGlobalDispatcher(dispatcher as unknown as Dispatcher)
  } else {
    setGlobalDispatcher(directAgent as unknown as Dispatcher)
  }

  consola.debug("HTTP agent reset: connection pool cleared")
}
