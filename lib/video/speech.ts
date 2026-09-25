import path from "node:path";
import { whisperModel } from "../config";
import type { Transcript } from "../types";
import { run } from "./ffmpeg";

export async function transcribeFile(audioPath: string, windows?: { start: number; end: number }[]): Promise<Transcript> {
  const script = path.join(process.cwd(), "scripts", "transcribe.py");
  const clips = windows?.length ? windows.flatMap((window) => [window.start.toFixed(2), window.end.toFixed(2)]).join(",") : "";
  const output = await run("python", [script, audioPath, whisperModel(), clips], 20 * 60_000);
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith("{")).pop();
  if (!line) throw new Error("Transcription returned nothing. Check that faster-whisper can read the soundtrack.");
  const parsed = JSON.parse(line) as Transcript;
  return {
    language: parsed.language || "und",
    text: parsed.text || "",
    words: Array.isArray(parsed.words) ? parsed.words : [],
  };
}
