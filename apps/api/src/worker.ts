import { Worker } from "bullmq";
import pino from "pino";
import { loadEnv } from "./env.js";
import { finalizeRecording } from "./routes/recordings.js";
import {
  cleanupOrphanedUploads,
  reconcileStaleSessions,
  retentionCleanup,
} from "./jobs/maintenance.js";
import { bullConnection, scheduleRepeatableJobs } from "./jobs/queue.js";
import { ensureBucket } from "./lib/s3.js";

/**
 * Background worker: recording finalization, retention cleanup,
 * stale-session reconciliation, orphaned-upload cleanup.
 * Failed jobs retry with exponential backoff; exhausted jobs land in the
 * failed set (dead-letter) for inspection.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL });
  await ensureBucket().catch((err) =>
    log.warn({ err }, "bucket_ensure_failed"),
  );
  await scheduleRepeatableJobs();

  const worker = new Worker(
    "liveread-jobs",
    async (job) => {
      log.info({ job: job.name, id: job.id }, "job_start");
      switch (job.name) {
        case "finalize-recording":
          await finalizeRecording(
            (job.data as { recordingId: string }).recordingId,
          );
          break;
        case "retention-cleanup": {
          const r = await retentionCleanup();
          log.info(r, "retention_cleanup_done");
          break;
        }
        case "stale-session-reconcile": {
          const r = await reconcileStaleSessions();
          if (r.ended > 0) log.info(r, "stale_sessions_ended");
          break;
        }
        case "orphan-cleanup": {
          const r = await cleanupOrphanedUploads();
          log.info(r, "orphan_cleanup_done");
          break;
        }
        default:
          log.warn({ job: job.name }, "unknown_job");
      }
    },
    { connection: bullConnection(), concurrency: 4 },
  );

  worker.on("failed", (job, err) => {
    log.error({ job: job?.name, id: job?.id, err: err.message }, "job_failed");
  });

  const shutdown = async () => {
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  log.info("worker_started");
}

main().catch((err) => {
  console.error("fatal_worker_error", err);
  process.exit(1);
});
