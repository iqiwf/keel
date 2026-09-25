import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config";
import { freeBytes } from "./video/ffmpeg";

const DISK_MARGIN = 32 * 1024 * 1024;

export interface HeldLock {
  pid: number;
  at: number;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockPath(projectId: string, root = dataDir()): string {
  return path.join(root, "locks", `${safeName(projectId)}.json`);
}

export function readLock(projectId: string, root = dataDir()): HeldLock | null {
  const file = lockPath(projectId, root);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HeldLock;
    if (!Number.isInteger(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** True when some other live process holds this source. A dead pid does not count. */
export function heldByLiveProcess(projectId: string, root = dataDir()): boolean {
  const lock = readLock(projectId, root);
  if (!lock || !pidAlive(lock.pid)) return false;
  return lock.pid !== process.pid;
}

export function liveLockIds(root = dataDir()): string[] {
  const dir = path.join(root, "locks");
  if (!fs.existsSync(dir)) return [];
  const ids: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const lock = readLock(id, root);
    if (lock && pidAlive(lock.pid)) ids.push(id);
  }
  return ids;
}

/** Exclusive claim. A lock whose process has exited can be taken over. */
export function claimFile(projectId: string, root = dataDir()): boolean {
  const file = lockPath(projectId, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, at: Date.now() });
  if (tryCreate(file, body)) return true;
  const current = readLock(projectId, root);
  if (current && pidAlive(current.pid)) return false;
  fs.rmSync(file, { force: true });
  return tryCreate(file, body);
}

export function releaseFile(projectId: string, root = dataDir()): void {
  const current = readLock(projectId, root);
  if (current && current.pid !== process.pid) return;
  fs.rmSync(lockPath(projectId, root), { force: true });
}

export function reservationFits(held: number, bytes: number, free: number | null): boolean {
  if (!Number.isFinite(bytes) || bytes < 0) return false;
  if (free === null) return true;
  return held + bytes + DISK_MARGIN <= free;
}

export function reservedBytes(root = dataDir()): number {
  const dir = path.join(root, "reservations");
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { pid?: number; bytes?: number };
      if (!pidAlive(Number(parsed.pid))) {
        fs.rmSync(path.join(dir, name), { force: true });
        continue;
      }
      if (Number.isFinite(parsed.bytes) && (parsed.bytes ?? 0) > 0) total += parsed.bytes as number;
    } catch {
      /* ignore a torn reservation file */
    }
  }
  return total;
}

/** Reserve bytes before they hit the disk. Backs out if the disk cannot hold every reservation. */
export function reserveDisk(id: string, bytes: number, root = dataDir()): boolean {
  if (!reservationFits(0, bytes, Number.MAX_SAFE_INTEGER)) return false;
  const file = path.join(root, "reservations", `${safeName(id)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid: process.pid, bytes, at: Date.now() });
  if (!tryCreate(file, body)) return false;
  const free = freeBytes(root);
  if (!reservationFits(reservedBytes(root) - bytes, bytes, free)) {
    fs.rmSync(file, { force: true });
    return false;
  }
  return true;
}

export function releaseDisk(id: string, root = dataDir()): void {
  fs.rmSync(path.join(root, "reservations", `${safeName(id)}.json`), { force: true });
}

function tryCreate(file: string, body: string): boolean {
  try {
    fs.writeFileSync(file, body, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}
