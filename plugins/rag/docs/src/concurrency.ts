/**
 * Run a list of async jobs with a bounded concurrency limit.
 *
 * Results are returned in the same order as the input jobs (not completion
 * order). If any job rejects, the returned promise rejects with that error
 * (the first rejection wins).
 *
 * Used to fan out embedding sub-batches without overwhelming the provider API.
 */
export async function runWithConcurrency<T>(
  jobs: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const total = jobs.length;
  const results = new Array<T>(total);
  if (total === 0) return results;

  const concurrency = Math.max(1, Math.min(limit || 1, total));
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= total) return;
      results[index] = await jobs[index]();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
