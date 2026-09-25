import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { dataDir, whisperModel } from "../config";
import type { Transcript, TranscriptWord } from "../types";
import { run } from "./ffmpeg";
import { sameWindows, type TimeWindow } from "./windows";

export interface TranscriptCache {
  fingerprint: string;
  model: string;
  windows: TimeWindow[];
  transcript: Transcript;
}

export async function transcribeFile(audioPath: string, windows?: TimeWindow[]): Promise<Transcript> {
  const script = path.join(process.cwd(), "scripts", "transcribe.py");
  const clips = windows?.length ? windows.flatMap((window) => [window.start.toFixed(2), window.end.toFixed(2)]).join(",") : "";
  const output = await run("python", [script, audioPath, whisperModel(), clips], 20 * 60_000);
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith("{")).pop();
  if (!line) throw new Error("Transcription returned nothing. Check that faster-whisper can read the soundtrack.");
  const parsed = JSON.parse(line) as Transcript;
  return {
    language: parsed.language || "und",
    text: parsed.text || "",
    words: alignWords(Array.isArray(parsed.words) ? parsed.words : [], windows),
  };
}

/**
 * faster-whisper seek offsets are absolute. If a build instead restarts each
 * clip at zero, shift those local times onto the source windows.
 * Words that already overlap a window are left alone.
 */
export function alignWords(words: TranscriptWord[], windows?: TimeWindow[]): TranscriptWord[] {
  const ordered = [...words].sort((a, b) => a.start - b.start);
  const spans = (windows ?? []).filter((window) => window.end > window.start).sort((a, b) => a.start - b.start);
  if (!ordered.length || !spans.length) return ordered;
  const overlaps = ordered.some((word) => spans.some((window) => word.end > window.start - 0.3 && word.start < window.end + 0.3));
  if (overlaps) return ordered;
  const covered = spans.reduce((sum, window) => sum + (window.end - window.start), 0);
  const span = ordered[ordered.length - 1].end - ordered[0].start;
  if (span > covered + 1 || ordered[0].start > 1.25) return ordered;
  let index = 0;
  let origin = 0;
  return ordered.map((word) => {
    while (index < spans.length - 1) {
      const duration = spans[index].end - spans[index].start;
      if (word.start < origin + duration - 0.05) break;
      origin += duration;
      index += 1;
    }
    const shift = spans[index].start - origin;
    return {
      ...word,
      start: round(word.start + shift),
      end: round(Math.max(word.start + shift, word.end + shift)),
    };
  });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function transcriptPath(projectId: string): string {
  return path.join(dataDir(), "analysis", `${projectId}.transcript.json`);
}

export function readTranscript(projectId: string): TranscriptCache | null {
  const file = transcriptPath(projectId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as TranscriptCache;
    if (!parsed.fingerprint || !parsed.model || !parsed.transcript || !Array.isArray(parsed.transcript.words)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function transcriptMatches(cached: TranscriptCache | null, fingerprint: string, model: string, windows?: TimeWindow[]): boolean {
  if (!cached || cached.fingerprint !== fingerprint || cached.model !== model) return false;
  const wanted = windows ?? [];
  if (!wanted.length) return cached.windows.length === 0;
  if (!cached.windows.length) return true;
  return sameWindows(cached.windows, wanted);
}

export function saveTranscript(projectId: string, cache: TranscriptCache): void {
  const file = transcriptPath(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}
