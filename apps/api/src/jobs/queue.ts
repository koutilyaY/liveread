import { Queue, type ConnectionOptions } from "bullmq";
import { env } from "../env.js";

/** BullMQ connection options parsed from REDIS_URL. */
export function bullConnection(): ConnectionOptions {
  const url = new URL(env().REDIS_URL);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.password ? { password: url.password } : {}),
    maxRetriesPerRequest: null,
  };
}

/**
 * Background jobs (BullMQ):
 *  - finalize-recording: concatenate chunks, checksum, mark stored
 *  - retention-cleanup: repeatable; deletes sessions past retention
 *  - stale-session-reconcile: repeatable; ends abandoned live sessions
 */

let queues: { jobs: Queue } | null = null;

export function getQueues(): { jobs: Queue } {
  if (!queues) {
    queues = {
      jobs: new Queue("liveread-jobs", {
        connection: bullConnection(),
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: "exponential", delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }),
    };
  }
  return queues;
}

export async function enqueueFinalizeRecording(
  recordingId: string,
): Promise<void> {
  await getQueues().jobs.add("finalize-recording", { recordingId });
}

export async function scheduleRepeatableJobs(): Promise<void> {
  const q = getQueues().jobs;
  await q.add(
    "retention-cleanup",
    {},
    { repeat: { pattern: "0 * * * *" }, jobId: "retention-cleanup" },
  );
  await q.add(
    "stale-session-reconcile",
    {},
    { repeat: { pattern: "*/10 * * * *" }, jobId: "stale-session-reconcile" },
  );
}

export async function closeQueues(): Promise<void> {
  if (queues) {
    await queues.jobs.close();
    queues = null;
  }
}
