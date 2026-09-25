import type { HighlightDraft, Transcript, TranscriptWord } from "./types";

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function wordsInside(words: TranscriptWord[], start: number, end: number): TranscriptWord[] {
  return words.filter((word) => word.end > start && word.start < end).sort((a, b) => a.start - b.start);
}

function scoreWindow(words: TranscriptWord[], start: number, end: number): { score: number; start: number; end: number } {
  const spoken = wordsInside(words, start, end);
  if (!spoken.length) return { score: 0, start, end };
  const speech = spoken.reduce((sum, word) => sum + Math.max(0, Math.min(end, word.end) - Math.max(start, word.start)), 0);
  const first = Math.max(start, spoken[0].start);
  const last = Math.min(end, spoken[spoken.length - 1].end);
  const lead = Math.max(0, first - start);
  let gap = 0;
  for (let index = 1; index < spoken.length; index += 1) {
    gap = Math.max(gap, spoken[index].start - spoken[index - 1].end);
  }
  const span = Math.max(0.5, end - start);
  const front = spoken.filter((word) => word.start < start + span * 0.4);
  const frontSpeech = front.reduce((sum, word) => sum + Math.max(0, word.end - word.start), 0);
  const hook = frontSpeech > speech * 0.55 ? 1.2 : 0;
  const filler = spoken.filter((word) => /^(um+|uh+|er+|ah+|like)$/i.test(word.text)).length;
  const question = spoken.some((word) => word.text.endsWith("?")) ? 0.8 : 0;
  return { score: speech + (speech / span) * 4 + hook + question - filler * 0.45 - lead * 0.45 - gap * 0.9, start: first, end: last };
}

export function highlightsFromSpeech(duration: number, targetSeconds: number, transcript: Transcript): HighlightDraft[] {
  const length = Math.min(targetSeconds, Math.max(8, duration * 0.9));
  const slots = duration < 25 ? 2 : duration < 70 ? 3 : 4;
  const words = [...transcript.words].sort((a, b) => a.start - b.start);
  if (!words.length) {
    return spaced(duration, length, slots).map((range, index) => ({
      title: index === 0 ? "Opening passage" : `Passage ${index + 1}`,
      hook: "No speech was found in this passage",
      reason: "Placed on the timeline because the soundtrack had no recognizable words.",
      score: round(Math.max(0.05, 0.4 - index * 0.05)),
      start: range.start,
      end: range.end,
      captionText: "",
    }));
  }
  const step = Math.max(1, length / 6);
  const ranked: { score: number; start: number; end: number }[] = [];
  for (let start = 0; start + 3 < duration; start += step) {
    const end = Math.min(duration, start + length);
    ranked.push(scoreWindow(words, start, end));
  }
  ranked.sort((a, b) => b.score - a.score);
  const chosen: { start: number; end: number; score: number }[] = [];
  for (const candidate of ranked) {
    if (candidate.score <= 0) continue;
    const range = pad(candidate, duration, Math.min(length, Math.max(8, targetSeconds)));
    if (chosen.some((item) => Math.min(item.end, range.end) - Math.max(item.start, range.start) > 1.5)) continue;
    chosen.push(range);
    if (chosen.length >= slots) break;
  }
  if (!chosen.length) return highlightsFromSpeech(duration, targetSeconds, { ...transcript, words: [] });
  chosen.sort((a, b) => a.start - b.start);
  return chosen.map((range, index) => {
    const spoken = wordsInside(words, range.start, range.end).map((word) => word.text).join(" ");
    const best = Math.max(...ranked.map((item) => item.score), 1);
    return {
      title: spoken.split(/\s+/).slice(0, 6).join(" ") || `Passage ${index + 1}`,
      hook: spoken.split(/\s+/).slice(0, 10).join(" "),
      reason: "Chosen because the speech starts cleanly and holds together.",
      score: round(Math.min(0.98, 0.45 + (range.score / best) * 0.5)),
      start: round(range.start),
      end: round(range.end),
      captionText: spoken,
    };
  });
}

function pad(range: { start: number; end: number; score: number }, duration: number, wanted: number): { start: number; end: number; score: number } {
  let start = range.start;
  let end = Math.max(range.end, start + 3);
  const missing = Math.max(0, Math.min(wanted, duration) - (end - start));
  start = Math.max(0, start - missing * 0.25);
  end = Math.min(duration, end + missing * 0.75);
  if (end - start < 3) end = Math.min(duration, start + 3);
  return { start, end, score: range.score };
}

function spaced(duration: number, length: number, slots: number): { start: number; end: number }[] {
  const span = Math.max(0, duration - length);
  return Array.from({ length: slots }, (_, slot) => {
    const start = slots <= 1 ? span * 0.12 : (span * slot) / Math.max(1, slots - 1);
    return { start: round(start), end: round(Math.min(duration, start + length)) };
  });
}
