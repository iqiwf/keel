import type { HighlightDraft, Transcript } from "./types";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function highlightsFromSpeech(duration: number, targetSeconds: number, transcript: Transcript): HighlightDraft[] {
  const length = Math.min(targetSeconds, Math.max(8, duration * 0.9));
  const slots = duration < 25 ? 2 : duration < 70 ? 3 : 4;
  const words = transcript.words;
  if (!words.length) {
    return spaced(duration, length, slots).map((range, index) => ({
      title: index === 0 ? "Opening passage" : `Passage ${index + 1}`,
      hook: "No speech was found in this passage",
      reason: "Placed on the timeline because the soundtrack had no recognizable words.",
      score: round(0.4 - index * 0.05),
      start: range.start,
      end: range.end,
      captionText: "",
    }));
  }
  const step = Math.max(2, length / 4);
  const candidates: { start: number; end: number; score: number }[] = [];
  for (let start = 0; start + 3 < duration; start += step) {
    const end = Math.min(duration, start + length);
    const spoken = words.filter((word) => word.end > start && word.start < end);
    const coverage = spoken.reduce((sum, word) => sum + Math.max(0, word.end - word.start), 0);
    candidates.push({ start, end, score: coverage });
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen: { start: number; end: number; score: number }[] = [];
  for (const candidate of candidates) {
    if (chosen.some((item) => Math.min(item.end, candidate.end) - Math.max(item.start, candidate.start) > length * 0.35)) continue;
    chosen.push(candidate);
    if (chosen.length >= slots) break;
  }
  chosen.sort((a, b) => a.start - b.start);
  return chosen.map((range, index) => {
    const spoken = words.filter((word) => word.end > range.start && word.start < range.end).map((word) => word.text).join(" ");
    return {
      title: spoken.split(" ").slice(0, 6).join(" ") || `Passage ${index + 1}`,
      hook: spoken.split(" ").slice(0, 10).join(" "),
      reason: "Chosen for how much clear speech it holds.",
      score: round(Math.min(0.98, 0.55 + range.score / Math.max(1, length))),
      start: round(range.start),
      end: round(range.end),
      captionText: spoken,
    };
  });
}

function spaced(duration: number, length: number, slots: number): { start: number; end: number }[] {
  const span = Math.max(0, duration - length);
  return Array.from({ length: slots }, (_, slot) => {
    const start = slots <= 1 ? span * 0.12 : (span * slot) / (slots - 1);
    return { start: round(start), end: round(Math.min(duration, start + length)) };
  });
}
