import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dataDir } from "../config";
import type { DetectSample, SubjectTrack } from "./reframe";
import { faceStats, followSubject } from "./reframe";
import { run } from "./ffmpeg";
import { sameWindows, type TimeWindow } from "./windows";

export function trackPath(projectId: string): string {
  return path.join(dataDir(), "analysis", `${projectId}.json`);
}

export function sourceFingerprint(file: string): string {
  const stat = fs.statSync(file);
  return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

export function readTrack(projectId: string): SubjectTrack | null {
  const file = trackPath(projectId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SubjectTrack;
    if (!parsed.width || !parsed.height || !Array.isArray(parsed.points)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function trackMatches(track: SubjectTrack | null, fingerprint: string, windows?: TimeWindow[]): boolean {
  if (!track?.fingerprint || track.fingerprint !== fingerprint) return false;
  if (!windows?.length) return !track.coverage?.length;
  if (!track.coverage?.length) return true;
  return sameWindows(track.coverage, windows);
}

export function saveTrack(projectId: string, track: SubjectTrack): void {
  const file = trackPath(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(track));
  fs.renameSync(tmp, file);
}

export async function detectTrack(source: string, windows?: { start: number; end: number }[]): Promise<SubjectTrack> {
  const script = path.join(process.cwd(), "scripts", "detect_subjects.py");
  const ranges = windows?.length ? windows : [{ start: 0, end: 0 }];
  const batches = await Promise.all(ranges.map(async (window) => {
    const args = [script, source];
    if (window.end > window.start) args.push(String(window.start), String(window.end));
    const output = await run("python", args, 12 * 60_000);
    return parseSamples(output);
  }));
  const width = batches.find((batch) => batch.width > 1)?.width ?? 0;
  const height = batches.find((batch) => batch.height > 1)?.height ?? 0;
  const samples = batches.flatMap((batch) => batch.samples).sort((a, b) => a.t - b.t);
  if (width < 2 || height < 2) throw new Error("Could not read the picture size for reframing.");
  return {
    width,
    height,
    face: faceStats(samples),
    points: followSubject(samples, width, height),
    coverage: windows?.filter((window) => window.end > window.start),
  };
}

function parseSamples(output: string): { width: number; height: number; samples: DetectSample[] } {
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith("{")).pop();
  if (!line) throw new Error("Speaker tracking returned nothing.");
  const parsed = JSON.parse(line) as { width: number; height: number; samples: DetectSample[] };
  const width = Number(parsed.width) || 0;
  const height = Number(parsed.height) || 0;
  if (width < 2 || height < 2) throw new Error("Could not read the picture size for reframing.");
  return { width, height, samples: Array.isArray(parsed.samples) ? parsed.samples : [] };
}
