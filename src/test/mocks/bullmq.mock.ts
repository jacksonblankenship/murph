import type { Job } from 'bullmq';

/**
 * Creates a mock BullMQ Queue.
 */
export function createMockQueue() {
  const jobs = new Map<string, { data: unknown; opts: unknown }>();
  const repeatableJobs: Array<{ id?: string; key: string }> = [];

  return {
    jobs,
    repeatableJobs,

    async add(
      name: string,
      data: unknown,
      opts?: { jobId?: string; delay?: number; repeat?: { pattern: string } },
    ): Promise<Job> {
      const jobId = opts?.jobId ?? `job-${Date.now()}`;
      jobs.set(jobId, { data, opts });

      if (opts?.repeat) {
        repeatableJobs.push({ id: jobId, key: `${name}:${jobId}` });
      }

      return { id: jobId, data, opts } as unknown as Job;
    },

    async getJob(jobId: string): Promise<Job | undefined> {
      const job = jobs.get(jobId);
      if (!job) return undefined;
      return {
        id: jobId,
        data: job.data,
        opts: job.opts,
        remove: async () => {
          jobs.delete(jobId);
        },
      } as unknown as Job;
    },

    async getRepeatableJobs() {
      return repeatableJobs;
    },

    async removeRepeatableByKey(key: string) {
      const idx = repeatableJobs.findIndex(j => j.key === key);
      if (idx >= 0) {
        repeatableJobs.splice(idx, 1);
      }
    },

    clear() {
      jobs.clear();
      repeatableJobs.length = 0;
    },
  };
}

export type MockQueue = ReturnType<typeof createMockQueue>;
