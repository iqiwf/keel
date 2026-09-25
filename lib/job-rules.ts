/** A live job blocks another mark. A crashed job does not. */
export function canMark(duration: number, live: boolean): boolean {
  return duration >= 3 && !live;
}

/** Stop stays available for a running job and for one left stuck on analyzing. */
export function canStop(status: string, live: boolean): boolean {
  return live || status === "analyzing";
}

export function sourceBusy(isClaimed: boolean): boolean {
  return isClaimed;
}
