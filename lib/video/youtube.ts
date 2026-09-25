import fs from "node:fs";
import path from "node:path";
import { freeBytes, run } from "./ffmpeg";

export function downloadCapMb(): number {
  const mb = Number(process.env.MAX_DOWNLOAD_MB ?? "4096");
  if (!Number.isFinite(mb) || mb < 50 || mb > 8192) return 4096;
  return Math.floor(mb);
}

/** Remove a failed download's fragments without touching a finished file. */
export function removeDownloadLeftovers(output: string): void {
  const dir = path.dirname(output);
  if (!fs.existsSync(dir)) return;
  const base = path.basename(output, path.extname(output));
  const finished = path.basename(output);
  for (const name of fs.readdirSync(dir)) {
    if (name === finished || !name.startsWith(base)) continue;
    if (!name.endsWith(".part") && !name.endsWith(".ytdl") && !/\.f\d+\./.test(name)) continue;
    const file = path.join(dir, name);
    if (path.resolve(file).startsWith(path.resolve(dir) + path.sep)) fs.rmSync(file, { force: true });
  }
}

export async function downloadYoutube(pageUrl: string, output: string): Promise<string> {
  const free = freeBytes(path.dirname(output));
  if (free !== null && free < 512 * 1024 * 1024) throw new Error("Not enough free disk space to fetch that video.");
  let printed = "";
  try {
    printed = await run(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-progress",
        "--restrict-filenames",
        "--no-write-info-json",
        "--no-write-comments",
        "--force-overwrites",
        "--max-filesize",
        `${downloadCapMb()}M`,
        "-f",
        "bv*[height<=720]+ba/b[height<=720]/b",
        "--merge-output-format",
        "mp4",
        "-o",
        output,
        "--print",
        "after_move:%(title)s",
        pageUrl,
      ],
      300_000,
    );
  } catch (error) {
    removeDownloadLeftovers(output);
    if (fs.existsSync(output) && fs.statSync(output).size < 1000) fs.rmSync(output, { force: true });
    throw error;
  }
  if (!fs.existsSync(output)) {
    const dir = path.dirname(output);
    const base = path.basename(output, path.extname(output));
    const found = fs.readdirSync(dir).find((name) => name === `${base}.mp4` || name === `${base}.mkv` || name === `${base}.webm`);
    if (!found) throw new Error("The download finished without a video file.");
    const from = path.join(dir, found);
    if (!from.startsWith(path.resolve(dir) + path.sep)) throw new Error("The download finished without a video file.");
    fs.renameSync(from, output);
  }
  removeDownloadLeftovers(output);
  const title = printed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("WARNING") && !/yt-dlp|ERROR|Deleting/i.test(line));
  return (title || "Untitled source").slice(0, 80);
}
