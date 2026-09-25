import path from "node:path";
import { whisperModel } from "../config";
import type { Transcript } from "../types";
import { run } from "./ffmpeg";

export async function transcribeFile(audioPath: string): Promise<Transcript> {
  const script = path.join(process.cwd(), "scripts", "transcribe.py");
  const output = await run("python", [script, audioPath, whisperModel()], 20 * 60_000);
  const line = output.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith("{")).pop();
  if (!line) throw new Error("Transcription returned nothing. Check that faster-whisper can read the soundtrack.");
  const parsed = JSON.parse(line) as Transcript;
  return {
    language: parsed.language || "und",
    text: parsed.text || "",
    words: Array.isArray(parsed.words) ? parsed.words : [],
  };
}
