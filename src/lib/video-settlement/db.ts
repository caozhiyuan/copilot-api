import type { SqliteDatabase } from "~/lib/storage/sqlite"
import type { VideoUsageJob } from "~/lib/types/token-usage"

export const VIDEO_USAGE_POLL_INTERVAL_MS = 5000

export function initializeVideoUsageJobs(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_key_video_jobs (
      provider_name TEXT NOT NULL,
      request_id TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      api_key_name TEXT,
      model TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      settled INTEGER NOT NULL DEFAULT 0,
      next_poll_at_ms INTEGER,
      PRIMARY KEY (provider_name, request_id)
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_key_video_jobs_due
    ON api_key_video_jobs(provider_name, next_poll_at_ms)
    WHERE next_poll_at_ms IS NOT NULL
  `)
  // Keep ownership and settlement for jobs accepted before the queue existed.
  db.exec(`
    INSERT INTO api_key_video_jobs (
      provider_name, request_id, api_key_id, api_key_name, model, trace_id,
      session_id, settled, next_poll_at_ms
    )
    SELECT pending.provider_name, substr(pending.upstream_request_id, 9),
      pending.api_key_id, pending.api_key_name, pending.model, pending.trace_id,
      pending.session_id, completed.id IS NOT NULL,
      CASE WHEN completed.id IS NULL THEN pending.created_at_ms ELSE NULL END
    FROM token_usage_events AS pending
    LEFT JOIN token_usage_events AS completed
      ON completed.source = pending.source
      AND completed.provider_name = pending.provider_name
      AND completed.endpoint = pending.endpoint
      AND completed.upstream_request_id = substr(pending.upstream_request_id, 9)
    WHERE pending.source = 'provider'
      AND pending.endpoint = 'videos_generations'
      AND pending.provider_name IS NOT NULL
      AND pending.api_key_id IS NOT NULL
      AND pending.total_cost_nanos = 0
      AND pending.upstream_request_id GLOB 'pending:*'
    ON CONFLICT (provider_name, request_id) DO NOTHING
  `)
}

export function readVideoUsageJob(
  db: SqliteDatabase,
  provider: string,
  requestId: string,
): VideoUsageJob | undefined {
  return (
    db
      .prepare<VideoUsageJob>(
        "SELECT * FROM api_key_video_jobs WHERE provider_name = ? AND request_id = ?",
      )
      .get(provider, requestId) ?? undefined
  )
}

export function writeVideoUsageJobRow(
  db: SqliteDatabase,
  job: Omit<VideoUsageJob, "settled" | "next_poll_at_ms">,
): void {
  db.prepare(
    `
    INSERT INTO api_key_video_jobs (
      provider_name, request_id, api_key_id, api_key_name, model, trace_id,
      session_id, next_poll_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider_name, request_id) DO NOTHING
  `,
  ).run(
    job.provider_name,
    job.request_id,
    job.api_key_id,
    job.api_key_name,
    job.model,
    job.trace_id,
    job.session_id,
    Date.now() + VIDEO_USAGE_POLL_INTERVAL_MS,
  )
}

export function queryDueVideoUsageJobRows(
  db: SqliteDatabase,
  provider: string,
  now: number,
  limit: number,
): Array<VideoUsageJob> {
  return db
    .prepare<VideoUsageJob>(
      `
    SELECT * FROM api_key_video_jobs
    WHERE provider_name = ? AND next_poll_at_ms <= ?
    ORDER BY next_poll_at_ms, request_id
    LIMIT ?
  `,
    )
    .all(provider, now, limit)
}

export function updateVideoUsageJobPollRow(
  db: SqliteDatabase,
  job: VideoUsageJob,
  nextPollAt: number,
): boolean {
  const result = db
    .prepare(
      `
    UPDATE api_key_video_jobs SET next_poll_at_ms = ?
    WHERE provider_name = ? AND request_id = ? AND next_poll_at_ms = ?
  `,
    )
    .run(nextPollAt, job.provider_name, job.request_id, job.next_poll_at_ms)
  return Boolean(result.changes)
}

export function clearVideoUsageJobPollRow(
  db: SqliteDatabase,
  job: VideoUsageJob,
): void {
  db.prepare(
    `
    UPDATE api_key_video_jobs SET next_poll_at_ms = NULL
    WHERE provider_name = ? AND request_id = ?
  `,
  ).run(job.provider_name, job.request_id)
}
