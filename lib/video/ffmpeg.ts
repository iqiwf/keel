import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { writeAss } from "../captions";
import type { Aspect, CaptionStyle, Cue } from "../types";
import type { CropPlan } from "./reframe";
import type { EnergyBin } from "./windows";

const exec = promisify(execFile);

function bin(name: string): string {
  return process.env[`${name.toUpperCase()}_PATH`] || name;
}

export async function run(command: string, args: string[], timeout = 180_000, cwd?: string): Promise<string> {
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
  return (await probeMedia(file)).duration;
}

export async function probeMedia(file: string): Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean }> {
  const output = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    file,
  ]);
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Could not read the video.");
  const parsed = JSON.parse(output.slice(start, end + 1)) as {
    format?: { duration?: string };
    streams?: { codec_type?: string }[];
  };
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0.4) throw new Error("Could not read the video length.");
  const streams = parsed.streams ?? [];
  const hasVideo = streams.some((stream) => stream.codec_type === "video");
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  if (!hasVideo) throw new Error("That file has no picture.");
  return { duration, hasVideo, hasAudio };
}

export function frameSize(aspect: Aspect): { width: number; height: number } {
  if (aspect === "9:16") return { width: 1080, height: 1920 };
  if (aspect === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function writeCropCommands(file: string, keys: { t: number; x: number; y: number }[]): void {
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
  const burned = cues.length ? cues : input.caption?.trim()
    ? [{ start: input.start, end: input.end, text: input.caption.trim() }]
    : [];

  if (burned.length) {
    writeAss({ file: captionPath, cues: burned, style: input.style, width, height, clipStart: input.start, clipEnd: input.end });
  }

  const filters: string[] = ["setpts=PTS-STARTPTS"];
  if (input.crop && input.crop.keys.length && input.crop.width >= 2 && input.crop.height >= 2) {
    writeCropCommands(commandPath, input.crop.keys);
    const first = input.crop.keys[0];
    filters.push(
      `crop=${input.crop.width}:${input.crop.height}:${first.x}:${first.y}`,
      `sendcmd=f='${ffmpegFilterPath(commandPath)}'`,
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
  if (burned.length && fs.existsSync(captionPath)) filters.push(`ass='${ffmpegFilterPath(captionPath)}'`);

  const duration = Math.max(0.4, Math.min(60 * 60, input.end - input.start));
  try {
    await run("ffmpeg", [
      "-y", "-ss", input.start.toFixed(3), "-i", input.source, "-t", duration.toFixed(3),
      "-map", "0:v:0", "-map", "0:a:0?", "-vf", filters.join(","),
      "-af", "asetpts=PTS-STARTPTS", "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-movflags", "+faststart", path.basename(input.output),
    ], 240_000, directory);
  } finally {
    fs.rmSync(captionPath, { force: true });
    fs.rmSync(commandPath, { force: true });
  }
}

export async function extractAudio(source: string, output: string): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await run("ffmpeg", ["-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", output]);
}

const ENERGY_RATE = 8000;

/** RMS of signed 16-bit PCM, in dBFS. Silence is reported as -100. */
export function rmsOfInt16(buffer: Buffer): number {
  const count = Math.floor(buffer.length / 2);
  if (!count) return -100;
  let sum = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = buffer.readInt16LE(index * 2) / 32768;
    sum += sample * sample;
  }
  const mean = sum / count;
  if (mean < 1e-10) return -100;
  return Math.round(20 * Math.log10(Math.sqrt(mean)) * 100) / 100;
}

/** One-second loudness bins. Streams PCM so a long source never fills the output buffer. */
export function scanEnergy(source: string): Promise<EnergyBin[]> {
  const windowBytes = ENERGY_RATE * 2;
  return new Promise((resolve, reject) => {
    const child = spawn(bin("ffmpeg"), [
      "-nostdin", "-v", "error",
      "-i", source, "-vn", "-ac", "1", "-ar", String(ENERGY_RATE),
      "-f", "s16le", "pipe:1",
    ], { windowsHide: true });
    const bins: EnergyBin[] = [];
    let leftover = Buffer.alloc(0);
    let second = 0;
    let stderr = "";
    const push = (chunk: Buffer) => {
      const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      let offset = 0;
      while (data.length - offset >= windowBytes) {
        bins.push({ t: second, rms: rmsOfInt16(data.subarray(offset, offset + windowBytes)) });
        second += 1;
        offset += windowBytes;
      }
      leftover = Buffer.from(data.subarray(offset));
    };
    child.stdout.on("data", (chunk: Buffer) => push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 600) stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("ffmpeg timed out while scanning loudness."));
    }, 10 * 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffmpeg failed: ${stderr.trim().slice(0, 600) || `exit ${code}`}`));
        return;
      }
      if (leftover.length >= ENERGY_RATE) bins.push({ t: second, rms: rmsOfInt16(leftover) });
      resolve(bins);
    });
  });
}
