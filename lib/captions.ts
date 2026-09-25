import fs from "node:fs";
import type { CaptionStyle, Cue, TranscriptWord } from "./types";

export type { Cue };

export function cuesFromWords(words: TranscriptWord[], start: number, end: number): Cue[] {
  const spoken = words
    .filter((word) => word.text.trim() && word.end > start + 0.02 && word.start < end - 0.02)
    .sort((a, b) => a.start - b.start);
  const cues: Cue[] = [];
  let bucket: TranscriptWord[] = [];
  const flush = () => {
    if (!bucket.length) return;
    const text = bucket.map((word) => word.text.trim()).join(" ").replace(/\s+/g, " ").trim();
    const cueStart = Math.max(start, bucket[0].start);
    const cueEnd = Math.min(end, Math.max(bucket[bucket.length - 1].end, cueStart + 0.35));
    if (text) cues.push({ start: round(cueStart), end: round(cueEnd), text: text.slice(0, 160) });
    bucket = [];
  };
  for (const word of spoken) {
    const nextSpan = bucket.length ? word.end - bucket[0].start : 0;
    if (bucket.length >= 5 || nextSpan >= 2.2) flush();
    bucket.push(word);
    if (/[.!?…]$/.test(word.text.trim())) flush();
  }
  flush();
  return cues;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const cs = Math.min(99, Math.floor((total - Math.floor(total)) * 100));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(cs)}`;
}

function assText(value: string): string {
  return value.replace(/\\/g, " ").replace(/[{}]/g, "").replace(/\r?\n/g, " ").trim();
}

function styleLine(name: CaptionStyle, height: number): string {
  const size = height >= 1600 ? 68 : height >= 1000 ? 54 : 40;
  if (name === "ticker") {
    return `Style: Active,Arial,${size},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,3,18,0,2,70,70,120,1`;
  }
  if (name === "quiet") {
    return `Style: Active,Arial,${size},&H00F4EFE6,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,80,80,110,1`;
  }
  return `Style: Active,Arial,${size},&H0012161A,&H000000FF,&H007AC2E4,&H007AC2E4,1,0,0,0,100,100,0,0,3,22,0,2,64,64,140,1`;
}

export function writeAss(input: {
  file: string;
  cues: Cue[];
  style: CaptionStyle;
  width: number;
  height: number;
  clipStart: number;
  clipEnd: number;
}): void {
  const events = input.cues
    .map((cue) => {
      const start = Math.max(0, cue.start - input.clipStart);
      const end = Math.min(input.clipEnd - input.clipStart, cue.end - input.clipStart);
      if (!cue.text.trim() || end - start < 0.12) return "";
      return `Dialogue: 0,${assTime(start)},${assTime(end)},Active,,0,0,0,,${assText(cue.text)}`;
    })
    .filter(Boolean);
  if (!events.length) return;
  const body = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${input.width}`,
    `PlayResY: ${input.height}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    styleLine(input.style, input.height),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
  fs.writeFileSync(input.file, body, "utf8");
}
