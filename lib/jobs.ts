const active = new Set<string>();
const cancelled = new Set<string>();
const controllers = new Map<string, AbortController>();

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
  controllers.delete(projectId);
}

export function claimed(projectId: string): boolean {
  return active.has(projectId);
}

export function arm(projectId: string): AbortSignal {
  const controller = new AbortController();
  controllers.set(projectId, controller);
  return controller.signal;
}

export function jobSignal(projectId: string): AbortSignal | undefined {
  return controllers.get(projectId)?.signal;
}

/** A crashed process leaves no claim, so a stale "analyzing" status can be retried. */
export function sourceBusy(isClaimed: boolean): boolean {
  return isClaimed;
}

export function requestCancel(projectId: string): void {
  cancelled.add(projectId);
  controllers.get(projectId)?.abort();
}

export function forgetCancel(projectId: string): void {
  cancelled.delete(projectId);
}

export function wasCancelled(projectId: string): boolean {
  return cancelled.has(projectId);
}
