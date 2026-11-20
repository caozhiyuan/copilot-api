import { persistApiKeyQuotaLedger } from "~/lib/auth/api-key-quota-store"
import type { SqliteDatabase } from "~/lib/storage/sqlite"
import type {
  PersistedTokenUsageEvent,
  RequestTiming,
} from "~/lib/types/token-usage"
import { readVideoUsageJob } from "~/lib/video-settlement/db"

import { getUsageDb } from "./db"

function insertTokenUsageEvent(
  db: SqliteDatabase,
  event: PersistedTokenUsageEvent,
): boolean {
  const result = db
    .prepare(
      `
      INSERT INTO token_usage_events (
        created_at_ms,
        created_at_utc,
        trace_id,
        session_id,
        user_id,
        source,
        endpoint,
        provider_name,
        model,
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_tokens,
        total_nano_aiu,
        cost_currency,
        total_cost_nanos,
        cost_source,
        request_id,
        upstream_request_id,
        first_token_ms,
        duration_ms,
        request_outcome,
        user_agent,
        api_key_id,
        api_key_name,
        api_key_cost_nanos
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, provider_name, endpoint, upstream_request_id) DO NOTHING
    `,
    )
    .run(
      event.created_at_ms,
      event.created_at_utc,
      event.trace_id,
      event.session_id,
      event.user_id,
      event.source,
      event.endpoint,
      event.provider_name,
      event.model,
      event.input_tokens,
      event.output_tokens,
      event.cache_read_input_tokens,
      event.cache_creation_input_tokens,
      event.total_tokens,
      event.total_nano_aiu,
      event.cost_currency,
      event.total_cost_nanos,
      event.cost_source,
      event.request_id,
      event.upstream_request_id ?? null,
      event.first_token_ms,
      event.duration_ms,
      event.request_outcome,
      event.user_agent,
      event.api_key_id ?? null,
      event.api_key_name ?? null,
      event.api_key_cost_nanos ?? null,
    )
  return Boolean(result.changes)
}

function insertVideoUsageEvent(
  db: SqliteDatabase,
  event: PersistedTokenUsageEvent,
  provider: string,
  requestId: string,
): boolean {
  db.exec("BEGIN IMMEDIATE")
  try {
    const job = readVideoUsageJob(db, provider, requestId)
    const inserted = !job?.settled && insertTokenUsageEvent(db, event)
    if (job && !job.settled) {
      db.prepare(
        `UPDATE api_key_video_jobs SET settled = 1, next_poll_at_ms = NULL
         WHERE provider_name = ? AND request_id = ?`,
      ).run(provider, requestId)
    }
    db.exec("COMMIT")
    return inserted
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

export async function writeTokenUsageEvent(
  event: PersistedTokenUsageEvent,
  db?: SqliteDatabase,
): Promise<boolean> {
  const resolvedDb = db ?? (await getUsageDb())
  return (
      event.source === "provider"
        && event.endpoint === "videos_generations"
        && event.provider_name
        && event.upstream_request_id
    ) ?
      insertVideoUsageEvent(
        resolvedDb,
        event,
        event.provider_name,
        event.upstream_request_id,
      )
    : insertTokenUsageEvent(resolvedDb, event)
}

export async function writeTokenUsageTiming(
  timing: Pick<RequestTiming, "id" | "firstTokenMs" | "durationMs" | "outcome">,
  db?: SqliteDatabase,
): Promise<void> {
  const resolvedDb = db ?? (await getUsageDb())
  resolvedDb
    .prepare(
      `
    UPDATE token_usage_events
    SET first_token_ms = ?, duration_ms = ?, request_outcome = ?
    WHERE request_id = ?
    `,
    )
    .run(timing.firstTokenMs, timing.durationMs, timing.outcome, timing.id)
}

export async function deleteExpiredUsageEvents(
  cutoffMs: number,
  db?: SqliteDatabase,
): Promise<number> {
  const resolvedDb = db ?? (await getUsageDb())
  persistApiKeyQuotaLedger(resolvedDb)
  const result = resolvedDb
    .prepare("DELETE FROM token_usage_events WHERE created_at_ms < ?")
    .run(cutoffMs)
  return Number(result.changes)
}
