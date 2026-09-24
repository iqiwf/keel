import type { HighlightDraft, Transcript, TranscriptWord } from "../types";
import type { AiProvider, AnalyzeInput } from "./types";

const BEATS = [
  "The part people replay",
  "A clean before-and-after",
  "The line that starts the argument",
  "A quiet detail that pays off",
  "The moment the pace changes",
  "A practical tip, said once",
];

function wordsFor(duration: number): TranscriptWord[] {
  const script = [
    "Here", "is", "the", "piece", "worth", "keeping",
    "Watch", "what", "changes", "in", "the", "next", "few", "seconds",
    "This", "is", "the", "line", "the", "rest", "of", "the", "video", "hangs", "on",
    "Cut", "here", "if", "you", "want", "the", "short", "version",
    "The", "detail", "is", "small", "and", "it", "matters",
    "Say", "it", "plainly", "then", "show", "the", "result",
  ];
  const words: TranscriptWord[] = [];
  const step = Math.max(0.35, duration / script.length);
  script.forEach((text, index) => {
    const start = Math.min(duration - 0.2, index * step);
    words.push({ start: round(start), end: round(Math.min(duration, start + step * 0.8)), text });
  });
  return words;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function windowAt(duration: number, target: number, slot: number, slots: number): { start: number; end: number } {
  const length = Math.min(target, Math.max(8, duration * 0.9));
  const span = Math.max(0, duration - length);
  const start = slots <= 1 ? span * 0.15 : (span * slot) / (slots - 1);
  return { start: round(start), end: round(Math.min(duration, start + length)) };
}

export const mockProvider: AiProvider = {
  name: "mock",
  async transcribe(input) {
    const words = wordsFor(input.duration);
    return {
      language: "en",
      text: words.map((word) => word.text).join(" "),
      words,
    };
  },
  async findHighlights(input, transcript) {
    const slots = input.duration < 25 ? 2 : input.duration < 70 ? 3 : 4;
    const drafts: HighlightDraft[] = [];
    for (let slot = 0; slot < slots; slot += 1) {
      const range = windowAt(input.duration, input.targetSeconds, slot, slots);
      const spoken = transcript.words
        .filter((word) => word.start >= range.start && word.end <= range.end + 0.4)
        .map((word) => word.text)
        .join(" ");
      drafts.push({
        title: BEATS[slot % BEATS.length],
        hook: spoken.split(" ").slice(0, 8).join(" ") || "Keep this passage",
        reason: "Selected from pacing, a spoken turn, and a length that fits a short.",
        score: round(0.92 - slot * 0.08),
        start: range.start,
        end: range.end,
        captionText: spoken || "Keep this passage.",
      });
    }
    return drafts;
  },
};
