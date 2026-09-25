export interface EnergyBin {
  t: number;
  rms: number;
}

export interface TimeWindow {
  start: number;
  end: number;
}

const LOUD = -42;
const AUDIBLE = -62;

/** Pick a few speech-heavy windows instead of the whole timeline. */
export function selectWindows(bins: EnergyBin[], duration: number, targetSeconds: number): TimeWindow[] {
  const safeDuration = Math.max(3, duration);
  const length = Math.min(Math.max(targetSeconds + 8, 20), 45, safeDuration);
  const slots = safeDuration < 25 * 60 ? 4 : 6;
  if (!bins.length) return spread(safeDuration, length, Math.min(slots, 3));
  const step = Math.max(2, length / 5);
  const ranked: { start: number; end: number; score: number; peak: number; loud: number }[] = [];
  for (let start = 0; start + 8 < safeDuration; start += step) {
    const end = Math.min(safeDuration, start + length);
    const inside = bins.filter((bin) => bin.t >= start && bin.t < end);
    const loud = inside.filter((bin) => bin.rms > LOUD).length;
    const lead = inside.findIndex((bin) => bin.rms > LOUD);
    const peak = inside.reduce((max, bin) => Math.max(max, bin.rms), -100);
    const score = loud * 3 + Math.max(0, peak - AUDIBLE) / 8 - (lead > 0 ? lead * 0.15 : 0);
    ranked.push({ start, end, score, peak, loud });
  }
  const band = safeDuration / slots;
  const chosen: TimeWindow[] = [];
  for (let index = 0; index < slots; index += 1) {
    const from = index * band;
    const to = from + band;
    const inBand = ranked.filter((item) => item.start >= from && item.start < to);
    const loudest = inBand.filter((item) => item.loud > 0).sort((a, b) => b.score - a.score)[0];
    const audible = inBand.filter((item) => item.peak > AUDIBLE).sort((a, b) => b.score - a.score)[0];
    const best = loudest ?? audible;
    if (!best) continue;
    chosen.push({ start: Math.max(0, best.start - 1), end: Math.min(safeDuration, best.end + 2) });
  }
  if (!chosen.length) return spread(safeDuration, length, Math.min(slots, 3));
  return chosen.sort((a, b) => a.start - b.start);
}

export function sameWindows(saved: TimeWindow[] | undefined, wanted: TimeWindow[]): boolean {
  if (!saved || saved.length !== wanted.length) return false;
  return wanted.every((window, index) => Math.abs(saved[index].start - window.start) < 0.2 && Math.abs(saved[index].end - window.end) < 0.2);
}

function spread(duration: number, length: number, slots: number): TimeWindow[] {
  const span = Math.max(0, duration - length);
  return Array.from({ length: slots }, (_, index) => {
    const start = slots <= 1 ? span * 0.15 : (span * index) / Math.max(1, slots - 1);
    return { start, end: Math.min(duration, start + length) };
  });
}

export function parseEnergy(log: string): EnergyBin[] {
  const bins: EnergyBin[] = [];
  let time = 0;
  for (const line of log.split(/\r?\n/)) {
    const stamp = line.match(/pts_time:([0-9.]+)/);
    if (stamp) time = Number(stamp[1]);
    const level = line.match(/RMS_level=(-?[0-9.]+|inf|-inf)/i);
    if (!level) continue;
    const raw = level[1].toLowerCase();
    const rms = raw.includes("inf") ? -100 : Number(raw);
    if (Number.isFinite(rms)) bins.push({ t: time, rms });
  }
  return bins;
}
