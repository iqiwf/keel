import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { writeAss } from "../captions";
import type { Aspect, CaptionStyle, Cue } from "../types";
import type { CropPlan } from "./reframe";

const exec = promisify(execFile);

function bin(name: string): string {
  return process.env[\`${name.toUpperCase()}_PATH\`] || name;
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
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
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
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
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

function writeCropCommands(
  file: string,
  keys: { t: number; x: number; y: number }[],
): void {
  const lines = keys.map((key, index) => {
    const next = keys[index + 1]?.t ?? key.t + 0.2;
    return `${key.t.toFixed(3)}-${Math.max(next, key.t + 0.05).toFixed(3)} crop x ${key.x}, crop y ${key.y};`;
  });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
}

function ffmpegFilterPath(file: string): string {
  return file.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export async function renderClip(input: {
  source: string;
  output: string;
  start: number;
  end: number;
  aspect: Aspect;
  style: CaptionStyle;
  cues?: Cue[];
  caption?: string;
  crop?: CropPlan | null;
}): Promise<void> {
  const { width, height } = frameSize(input.aspect);
  const directory = path.dirname(input.output);
  fs.mkdirSync(directory, { recursive: true });

  const stem = path.basename(input.output, ".mp4");
  const captionPath = path.join(directory, `${stem}.ass`);
  const commandPath = path.join(directory, `${stem}.cmd`);
  const cues = input.cues?.filter((cue) => cue.text.trim()) ?? [];
  const burned = cues.length
    ? cues
    : input.caption?.trim()
      ? [{ start: input.start, end: input.end, text: input.caption.trim() }]
      : [];

  if (burned.length) {
    writeAss({
      file: captionPath,
      cues: burned,
      style: input.style,
      width,
      height,
      clipStart: input.start,
      clipEnd: input.end,
    });
  }

  const filters: string[] = ["setpts=PTS-STARTPTS"];
  if (input.crop && input.crop.keys.length && input.crop.width >= 2 && input.crop.height >= 2) {
    writeCropCommands(commandPath, input.crop.keys);
    const first = input.crop.keys[0];
    filters.push(
      `crop=${input.crop.width}:${input.crop.height}:${first.x}:${first.y}`,
      `sendcmd=f='${ffmpegFilterPath(commandPath)}'`,
    );
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      "setsar=1",
    );
  } else {
    filters.push(
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${width}:${height}`,
      "setsar=1",
    );
  }

  if (burned.length && fs.existsSync(captionPath)) {
    filters.push(`ass='${ffmpegFilterPath(captionPath)}'`);
  }

  const duration = Math.max(0.4, Math.min(60 * 60, input.end - input.start));
  try {
    await run(
      "ffmpeg",
      [
        "-y",
        "-ss", input.start.toFixed(3),
        "-i", input.source,
        "-t", duration.toFixed(3),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-vf", filters.join(","),
        "-af", "asetpts=PTS-STARTPTS",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "160k",
        "-ar", "48000",
        "-movflags", "+faststart",
        path.basename(input.output),
      ],
      240_000,
      directory,
    );
  } finally {
    fs.rmSync(captionPath, { force: true });
    fs.rmSync(commandPath, { force: true });
  }
}

export async function extractAudio(source: string, output: string): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run("ffmpeg", [
    "-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", output,
  ]);
}
