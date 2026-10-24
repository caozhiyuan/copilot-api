import consola from "consola"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { EventBus } from "./event-bus"
import type {
  GatewayPluginApi,
  GatewayPluginEvents,
  GatewayPluginSetup,
} from "./types/gateway-plugins"
export type {
  GatewayPluginApi,
  GatewayPluginEvents,
  GatewayPluginSetup,
  PluginRequest,
} from "./types/gateway-plugins"

const MAX_PENDING_EVENTS = 1024

interface PluginState {
  name: string
  pending: number
  overflowReported: boolean
  tail: Promise<void>
  unsubscribe: Array<() => void>
  cleanup?: () => void | Promise<void>
}

// Each plugin has a bounded, ordered queue. Requests never await plugin I/O.
export class GatewayPlugins {
  private readonly bus = new EventBus<GatewayPluginEvents>()
  private readonly plugins: Array<PluginState> = []
  private subscriptions = 0
  private closing: Promise<void> | undefined

  private readonly port: number

  constructor(port: number) {
    this.port = port
  }

  get enabled(): boolean {
    return this.subscriptions > 0
  }

  async register(name: string, setup: GatewayPluginSetup): Promise<void> {
    if (this.closing) throw new Error("Gateway plugins are closing")
    const plugin: PluginState = {
      name,
      pending: 0,
      overflowReported: false,
      tail: Promise.resolve(),
      unsubscribe: [],
    }
    const api: GatewayPluginApi = Object.freeze({
      version: 1 as const,
      server: Object.freeze({ pid: process.pid, port: this.port }),
      on: <Name extends keyof GatewayPluginEvents>(
        event: Name,
        handler: (
          value: Readonly<GatewayPluginEvents[Name]>,
        ) => void | Promise<void>,
      ) => {
        if (this.closing) throw new Error("Gateway plugins are closing")
        const off = this.bus.subscribe(event, (value) => {
          if (plugin.pending >= MAX_PENDING_EVENTS) {
            if (!plugin.overflowReported) {
              plugin.overflowReported = true
              consola.warn(
                `Plugin '${name}' event queue is full; dropping events`,
              )
            }
            return
          }
          plugin.pending++
          plugin.tail = plugin.tail.then(async () => {
            try {
              await handler(value)
            } catch (error) {
              consola.warn(`Plugin '${name}' hook failed`, error)
            } finally {
              plugin.pending--
              if (!plugin.pending) plugin.overflowReported = false
            }
          })
        })
        this.subscriptions++
        let active = true
        const unsubscribe = () => {
          if (!active) return
          active = false
          off()
          this.subscriptions--
        }
        plugin.unsubscribe.push(unsubscribe)
        return unsubscribe
      },
      log: (message: string) => consola.info(`[plugin:${name}] ${message}`),
    })
    try {
      const cleanup = await setup(api)
      if (typeof cleanup === "function") plugin.cleanup = cleanup
      this.plugins.push(plugin)
    } catch (error) {
      for (const off of plugin.unsubscribe) off()
      throw error
    }
  }

  publish<Name extends keyof GatewayPluginEvents>(
    name: Name,
    event: GatewayPluginEvents[Name],
  ): void {
    if (this.enabled) {
      const snapshot = { ...event }
      Object.freeze(snapshot)
      this.bus.publish<Name>(name, snapshot)
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.plugins.map((plugin) => plugin.tail))
  }

  close(timeoutMs = 2000): Promise<void> {
    if (this.closing) return this.closing
    for (const plugin of this.plugins) {
      for (const off of plugin.unsubscribe) off()
    }
    let timer: ReturnType<typeof setTimeout>
    const shutdown = Promise.all(
      this.plugins.map(async (plugin) => {
        await plugin.tail
        try {
          await plugin.cleanup?.()
        } catch (error) {
          consola.warn(`Plugin '${plugin.name}' cleanup failed`, error)
        }
      }),
    )
    const timeout = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, timeoutMs)
    })
    this.closing = Promise.race([shutdown, timeout]).then(() => {
      clearTimeout(timer)
    })
    return this.closing
  }
}

export async function loadGatewayPlugins(
  setting: string | undefined,
  options: { port: number; baseDir: string },
): Promise<GatewayPlugins | undefined> {
  if (!setting?.trim()) return undefined
  const paths: unknown = JSON.parse(setting)
  if (
    !Array.isArray(paths)
    || !paths.every((path: unknown) => typeof path === "string" && path.trim())
  ) {
    throw new Error(
      "COPILOT_API_PLUGINS must be a JSON array of local module paths",
    )
  }
  const plugins = new GatewayPlugins(options.port)
  for (const path of new Set(paths as Array<string>)) {
    const url = pathToFileURL(resolve(options.baseDir, path)).href
    try {
      const module: unknown = await import(url)
      if (
        !module
        || typeof module !== "object"
        || !("default" in module)
        || typeof module.default !== "function"
      ) {
        throw new Error("Plugin must default-export a setup function")
      }
      await plugins.register(path, module.default as GatewayPluginSetup)
    } catch (error) {
      consola.warn(`Failed to load gateway plugin '${path}'`, error)
    }
  }
  return plugins
}
