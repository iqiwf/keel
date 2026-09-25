const active = new Set<string>();

/** One analyze or export at a time per source. A second claim is refused. */
export function claim(projectId: string): boolean {
  if (active.has(projectId)) return false;
  active.add(projectId);
  return true;
}

export function release(projectId: string): void {
  active.delete(projectId);
}

export function claimed(projectId: string): boolean {
  return active.has(projectId);
}
