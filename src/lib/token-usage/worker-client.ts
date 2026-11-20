import { Worker } from "node:worker_threads"

import type { ApiKeyQuotaBucket } from "../types/api-key"
import type {
  PersistedTokenUsageEvent,
  RequestTiming,
  TokenUsageDailySummary,
  TokenUsageEventsPage,
  TokenUsagePageInput,
  TokenUsagePeriod,
  TokenUsageSessionsPage,
  TokenUsageSummary,
  VideoUsageJob,
} from "../types/token-usage"

export interface UsageDatabaseOperations {
  writeTokenUsageEvent: (event: PersistedTokenUsageEvent) => Promise<boolean>
  writeTokenUsageTiming: (
    timing: Pick<
      RequestTiming,
      "id" | "firstTokenMs" | "durationMs" | "outcome"
    >,
  ) => Promise<void>
  getTokenUsageSummary: (
    period: TokenUsagePeriod,
    nowMs: number,
    apiKeyId?: string | null,
  ) => Promise<TokenUsageSummary>
  getTokenUsageDailySummary: (
    period: TokenUsagePeriod,
    nowMs: number,
    apiKeyId?: string | null,
  ) => Promise<TokenUsageDailySummary>
  getTokenUsageEventsPage: (
    input: TokenUsagePageInput,
    nowMs: number,
  ) => Promise<TokenUsageEventsPage>
  getTokenUsageSessionsPage: (
    input: TokenUsagePageInput,
    nowMs: number,
  ) => Promise<TokenUsageSessionsPage>
  pruneTokenUsageEvents: (cutoffMs: number) => Promise<number>
  closeUsageDatabase: () => Promise<void>
  flushApiKeyQuotas: () => Promise<void>
  readQuotaBuckets: (
    dayStartMs: number,
    monthStartMs: number,
  ) => Promise<Array<ApiKeyQuotaBucket>>
  getVideoUsageJob: (
    provider: string,
    requestId: string,
  ) => Promise<VideoUsageJob | undefined>
  saveVideoUsageJob: (
    job: Omit<VideoUsageJob, "settled" | "next_poll_at_ms">,
  ) => Promise<void>
  getDueVideoUsageJobs: (
    provider: string,
    now: number,
    limit: number,
  ) => Promise<Array<VideoUsageJob>>
  deferVideoUsageJob: (
    job: VideoUsageJob,
    nextPollAt: number,
  ) => Promise<boolean>
  stopPollingVideoUsageJob: (job: VideoUsageJob) => Promise<void>
}

export type UsageOperation = keyof UsageDatabaseOperations
type OperationArgs = {
  [Name in UsageOperation]: Parameters<UsageDatabaseOperations[Name]>
}
type OperationResult = {
  [Name in UsageOperation]: Awaited<ReturnType<UsageDatabaseOperations[Name]>>
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
