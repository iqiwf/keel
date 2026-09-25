import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config";
import type { DetectSample, SubjectTrack } from "./reframe";
import { faceStats, followSubject } from "./reframe";
import { run } from "./ffmpeg";

export function trackPath(projectId: string): string {
  return path.join(dataDir(), "analysis", `${projectId}.json`);
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

export function saveTrack(projectId: string, track: SubjectTrack): void {
  const file = trackPath(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(track));
}

export async function detectTrack(source: string): Promise<SubjectTrack> {
  const script = path.join(process.cwd(), "scripts", "detect_subjects.py");
  const output = await run("python", [script, source], 12 * 60_000);
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith("{")).pop();
  if (!line) throw new Error("Speaker tracking returned nothing.");
  const parsed = JSON.parse(line) as { width: number; height: number; samples: DetectSample[] };
  const width = Number(parsed.width) || 0;
  const height = Number(parsed.height) || 0;
  if (width < 2 || height < 2) throw new Error("Could not read the picture size for reframing.");
  const samples = Array.isArray(parsed.samples) ? parsed.samples : [];
  return {
    width,
    height,
    face: faceStats(samples),
    points: followSubject(samples, width, height),
  };
}
