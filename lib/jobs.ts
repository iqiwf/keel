const active = new Set<string>();
const cancelled = new Set<string>();

/** Production cap. The test runner raises it so parallel tests do not block each other. */
export const JOB_LIMIT = 2;

export function jobLimit(): number {
  if (process.env.NODE_TEST_CONTEXT) return 8;
  const raw = Number(process.env.KEEL_MAX_JOBS ?? JOB_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) return JOB_LIMIT;
  return Math.floor(raw);
}

export function atCapacity(): boolean {
  return active.size >= jobLimit();
}

/** One analyze or export at a time per source, and only a few heavy jobs at once. */
export function claim(projectId: string): boolean {
  if (active.has(projectId) || active.size >= jobLimit()) return false;
  active.add(projectId);
  return true;
}

export function release(projectId: string): void {
  active.delete(projectId);
}

export function claimed(projectId: string): boolean {
  return active.has(projectId);
}

export function requestCancel(projectId: string): void {
  cancelled.add(projectId);
}

export function forgetCancel(projectId: string): void {
  cancelled.delete(projectId);
}

export function wasCancelled(projectId: string): boolean {
  return cancelled.has(projectId);
}
