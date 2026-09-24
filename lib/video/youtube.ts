import fs from "node:fs";
import path from "node:path";
import { run } from "./ffmpeg";

export async function downloadYoutube(pageUrl: string, output: string): Promise<string> {
  const printed = await run(
    "yt-dlp",
    [
      "--no-playlist",
      "--no-progress",
      "--restrict-filenames",
      "--no-write-info-json",
      "--no-write-comments",
      "--force-overwrites",
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
  if (!fs.existsSync(output)) {
    const dir = path.dirname(output);
    const base = path.basename(output, path.extname(output));
    const found = fs.readdirSync(dir).find((name) => name.startsWith(base) && name !== path.basename(output));
    if (!found) throw new Error("The download finished without a video file.");
    fs.renameSync(path.join(dir, found), output);
  }
  const title = printed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("WARNING") && !/yt-dlp|ERROR|Deleting/i.test(line));
  return (title || "Untitled source").slice(0, 80);
}
