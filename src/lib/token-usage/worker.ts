import { parentPort } from "node:worker_threads"

import { usageDatabaseOperations } from "./store"
import type {
  UsageDatabaseHandlers,
  UsageOperation,
  UsageWorkerRequest,
  UsageWorkerResponse,
} from "./worker-client"

if (!parentPort) throw new Error("SQLite usage worker requires a parent port")

const port = parentPort
const handlers: UsageDatabaseHandlers = usageDatabaseOperations
let queue = Promise.resolve()

port.on(
  "message",
  <Name extends UsageOperation>(request: UsageWorkerRequest<Name>) => {
    // Reads and transactions follow usage writes in the order submitted.
    queue = queue.then(async () => {
      let response: UsageWorkerResponse<Name>
      try {
        response = {
          id: request.id,
          ok: true,
          value: await handlers[request.operation](...request.args),
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
  },
)
