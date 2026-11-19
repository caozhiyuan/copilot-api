import { Worker } from "node:worker_threads"

import type { usageDatabaseOperations } from "./store"

type Operations = typeof usageDatabaseOperations
export type UsageOperation = keyof Operations
type OperationArgs = {
  [Name in UsageOperation]: Parameters<Operations[Name]>
}
type OperationResult = {
  [Name in UsageOperation]: Awaited<ReturnType<Operations[Name]>>
}

export type UsageDatabaseHandlers = {
  [Name in UsageOperation]: (
    ...args: OperationArgs[Name]
  ) => Promise<OperationResult[Name]>
}

export type UsageWorkerRequest<Name extends UsageOperation = UsageOperation> = {
  [Key in Name]: { id: number; operation: Key; args: OperationArgs[Key] }
}[Name]

export type UsageWorkerResponse<Name extends UsageOperation = UsageOperation> =
  {
    id: number
  } & (
    | { ok: true; value: OperationResult[Name] }
    | { ok: false; error: string }
  )

interface PendingOperation {
  resolve: (value: OperationResult[UsageOperation]) => void
  reject: (reason: Error) => void
}

export class UsageWorker {
  private readonly worker: Worker
  private readonly pending = new Map<number, PendingOperation>()
  private idle: PromiseWithResolvers<void> | undefined
  private nextId = 0
  private failure: Error | undefined

  constructor(dbPath: string) {
    const filename =
      import.meta.url.endsWith(".ts") ? "./worker.ts" : "./usage-worker.js"
    this.worker = new Worker(new URL(filename, import.meta.url), {
      workerData: dbPath,
    })
    this.worker.on("message", (response: UsageWorkerResponse) => {
      const pending = this.pending.get(response.id)
      this.pending.delete(response.id)
      if (response.ok) pending?.resolve(response.value)
      else pending?.reject(new Error(response.error))
      this.unrefWhenIdle()
    })
    this.worker.on("error", (error) => this.fail(error))
    this.worker.on("exit", (code) =>
      this.fail(new Error(`SQLite usage worker exited with code ${code}`)),
    )
    this.worker.unref()
  }

  execute<Name extends UsageOperation>(
    operation: Name,
    ...args: OperationArgs[Name]
  ): Promise<OperationResult[Name]> {
    if (this.failure) return Promise.reject(this.failure)

    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, {
        resolve: (value) => resolve(value as OperationResult[Name]),
        reject,
      })
      this.worker.ref()
      try {
        this.worker.postMessage({
          id,
          operation,
          args,
        } satisfies UsageWorkerRequest<Name>)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
        this.unrefWhenIdle()
      }
    })
  }

  get failed(): boolean {
    return this.failure !== undefined
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) {
      this.idle ??= Promise.withResolvers<void>()
      await this.idle.promise
    }
  }

  async terminate(): Promise<void> {
    await this.worker.terminate()
  }

  private unrefWhenIdle(): void {
    if (this.pending.size > 0) return
    this.worker.unref()
    this.notifyIdle()
  }

  private notifyIdle(): void {
    this.idle?.resolve()
    this.idle = undefined
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const operation of this.pending.values()) operation.reject(error)
    this.pending.clear()
    this.notifyIdle()
  }
}
