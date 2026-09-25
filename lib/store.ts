import { once } from "node:events";
import { freeBytes } from "./video/ffmpeg";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dataDir } from "./config";
import type { Clip, Project, StoreData } from "./types";

const EMPTY: StoreData = { projects: [], clips: [] };

function file(): string {
  return path.join(dataDir(), "store.json");
}

function read(): StoreData {
  const target = file();
  if (!fs.existsSync(target)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as StoreData;
    if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.clips)) return structuredClone(EMPTY);
    return parsed;
  } catch {
    return structuredClone(EMPTY);
  }
}

function write(data: StoreData): void {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = file();
  const tmp = path.join(dir, `store.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

export function listProjects(): Project[] {
  return read().projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getProject(id: string): Project | null {
  return read().projects.find((item) => item.id === id) ?? null;
}

export function saveProject(project: Project): Project {
  const data = read();
  const index = data.projects.findIndex((item) => item.id === project.id);
  if (index >= 0) data.projects[index] = project;
  else data.projects.unshift(project);
  write(data);
  return project;
}

export function updateProject(id: string, patch: Partial<Project>): Project | null {
  const current = getProject(id);
  if (!current) return null;
  return saveProject({ ...current, ...patch, id: current.id });
}

export function clipsFor(projectId: string): Clip[] {
  return read().clips.filter((clip) => clip.projectId === projectId).sort((a, b) => b.score - a.score);
}

export function getClip(id: string): Clip | null {
  return read().clips.find((item) => item.id === id) ?? null;
}

export function saveClip(clip: Clip): Clip {
  const data = read();
  const index = data.clips.findIndex((item) => item.id === clip.id);
  if (index >= 0) data.clips[index] = clip;
  else data.clips.push(clip);
  write(data);
  return clip;
}

/** Merge onto the clip as it is now, so a stale copy cannot wipe a newer edit. */
export function patchClip(id: string, patch: Partial<Clip>): Clip | null {
  const data = read();
  const index = data.clips.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const next = { ...data.clips[index], ...patch, id };
  data.clips[index] = next;
  write(data);
  return next;
}

export function replaceClips(projectId: string, clips: Clip[]): void {
  const data = read();
  data.clips = data.clips.filter((clip) => clip.projectId !== projectId).concat(clips);
  write(data);
}

export function mastersDir(): string {
  const dir = path.join(dataDir(), "masters");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exportsDir(): string {
  const dir = path.join(dataDir(), "exports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function masterPath(project: Pick<Project, "fileName">): string {
  return path.join(mastersDir(), project.fileName);
}

/** Stream a browser file to disk and refuse anything past the byte cap. */
export async function writeBounded(file: File, target: string, max: number): Promise<void> {
  if (!Number.isFinite(file.size) || file.size > max) {
    throw new Error(`Files must be under ${Math.round(max / (1024 * 1024))} MB.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const free = freeBytes(path.dirname(target));
  if (free !== null && free < file.size + 32 * 1024 * 1024) throw new Error("Not enough free disk space for that file.");
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
  const out = fs.createWriteStream(tmp, { flags: "wx", mode: 0o600 });
  const reader = file.stream().getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > max) throw new Error(`Files must be under ${Math.round(max / (1024 * 1024))} MB.`);
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
    fs.renameSync(tmp, target);
  } catch (error) {
    out.destroy();
    await reader.cancel().catch(() => undefined);
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}