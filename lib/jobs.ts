import { claimFile, heldByLiveProcess, liveLockIds, releaseFile } from "./locks";
import { canMark, canStop, sourceBusy } from "./job-rules";

export { canMark, canStop, sourceBusy };

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
  return liveLockIds().length >= jobLimit();
}

/** One analyze or export at a time per source, including a job held by another process. */
export function claim(projectId: string): boolean {
  if (active.has(projectId) || heldByLiveProcess(projectId)) return false;
  const live = liveLockIds();
  if (!live.includes(projectId) && live.length >= jobLimit()) return false;
  if (!claimFile(projectId)) return false;
  active.add(projectId);
  return true;
}

export function release(projectId: string): void {
  active.delete(projectId);
  controllers.delete(projectId);
  releaseFile(projectId);
}

/** True only for a job this process started. Another process's lock is not ours to cancel. */
export function claimed(projectId: string): boolean {
  return active.has(projectId);
}

/** True when this process or any other live process holds the source. */
export function jobLive(projectId: string): boolean {
  return active.has(projectId) || heldByLiveProcess(projectId);
}

export function arm(projectId: string): AbortSignal {
  const controller = new AbortController();
  controllers.set(projectId, controller);
  return controller.signal;
}

export function jobSignal(projectId: string): AbortSignal | undefined {
  return controllers.get(projectId)?.signal;
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
