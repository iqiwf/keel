import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Aspect, CaptionStyle } from "../types";

const exec = promisify(execFile);

function bin(name: string): string {
  return process.env[`${name.toUpperCase()}_PATH`] || name;
}

export async function run(
  command: string,
  args: string[],
  timeout = 180_000,
  cwd?: string,
): Promise<string> {
  try {
    const { stdout, stderr } = await exec(bin(command), args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      cwd,
    });
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failed = error as { stderr?: string; message?: string };
    const detail = (failed.stderr || failed.message || "command failed").slice(0, 600);
    throw new Error(`${command} failed: ${detail}`);
  }
}

export async function probeDuration(file: string): Promise<number> {
  const output = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const duration = Number(output.trim().split(/\s+/)[0]);
  if (!Number.isFinite(duration) || duration <= 0.4) {
    throw new Error("Could not read the video length.");
  }
  return duration;
}

export function frameSize(aspect: Aspect): { width: number; height: number } {
  if (aspect === "9:16") return { width: 1080, height: 1920 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const cs = Math.floor((total - Math.floor(total)) * 100);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(cs)}`;
}

function assText(value: string): string {
  return value
    .replace(/\\/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\r?\n/g, "\\N")
    .slice(0, 220);
}

function styleLine(name: CaptionStyle, height: number): string {
  const size = height >= 1600 ? 58 : height === 1080 && name !== "quiet" ? 48 : 42;
  if (name === "ticker") {
    return `Style: Active,Arial,${size},&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,3,16,0,2,70,70,90,1`;
  }
  if (name === "quiet") {
    return `Style: Active,Arial,${size},&H00F4EFE6,&H000000FF,&H00302820,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,80,80,70,1`;
  }
  return `Style: Active,Arial,${size},&H0012161A,&H000000FF,&H00000000,&H007AC2E4,1,0,0,0,100,100,0,0,3,18,0,2,64,64,110,1`;
}

function writeCaption(file: string, caption: string, style: CaptionStyle, width: number, height: number, length: number): void {
  const body = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine(style, height),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,${assTime(0)},${assTime(length)},Active,,0,0,0,,${assText(caption)}`,
    "",
  ].join("\n");
  fs.writeFileSync(file, body, "utf8");
}

export async function renderClip(input: {
  source: string;
  output: string;
  start: number;
  end: number;
  aspect: Aspect;
  caption: string;
  style: CaptionStyle;
}): Promise<void> {
  const { width, height } = frameSize(input.aspect);
  const directory = path.dirname(input.output);
  fs.mkdirSync(directory, { recursive: true });
  const captionName = `${path.basename(input.output, ".mp4")}.ass`;
  const captionPath = path.join(directory, captionName);
  const length = Math.max(0.4, input.end - input.start);
  if (input.caption.trim()) writeCaption(captionPath, input.caption, input.style, width, height, length);

  const scale = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
  const filter = input.caption.trim() ? `${scale},ass=${captionName}` : scale;
  try {
    await run(
      "ffmpeg",
      [
        "-y",
        "-ss",
        input.start.toFixed(3),
        "-to",
        input.end.toFixed(3),
        "-i",
        input.source,
        "-vf",
        filter,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        path.basename(input.output),
      ],
      240_000,
      directory,
    );
  } finally {
    fs.rmSync(captionPath, { force: true });
  }
}

export async function extractAudio(source: string, output: string): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-i",
    source,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    output,
  ]);
}
