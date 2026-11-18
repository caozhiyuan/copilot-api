import { parentPort } from "node:worker_threads"

import { usageDatabaseOperations } from "./store"
import type { UsageWorkerRequest, UsageWorkerResponse } from "./worker-client"

if (!parentPort) throw new Error("SQLite usage worker requires a parent port")

const port = parentPort
let queue = Promise.resolve()

port.on("message", (request: UsageWorkerRequest) => {
  // Reads and transactions follow usage writes in the order submitted.
  queue = queue.then(async () => {
    let response: UsageWorkerResponse
    try {
      const operation = usageDatabaseOperations[request.operation] as (
        ...args: Array<unknown>
      ) => Promise<unknown>
      response = {
        id: request.id,
        ok: true,
        value: await operation(...request.args),
      }
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    port.postMessage(response)
  })
})
