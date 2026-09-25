import type { Aspect } from "../types";

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectSample {
  t: number;
  faces: FaceBox[];
  motion: { x: number; y: number } | null;
}

export interface SubjectPoint {
  t: number;
  x: number;
  y: number;
}

export interface SubjectTrack {
  width: number;
  height: number;
  face: { width: number; height: number } | null;
  points: SubjectPoint[];
  coverage?: { start: number; end: number }[];
}

export interface CropKey {
  t: number;
  x: number;
  y: number;
}

export interface CropPlan {
  width: number;
  height: number;
  keys: CropKey[];
}

interface LiveTrack {
  id: number;
  cx: number;
  cy: number;
  area: number;
  lead: number;
  seen: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function even(value: number): number {
  const rounded = Math.max(0, Math.round(value));
  return rounded - (rounded % 2);
}

export function aspectRatio(aspect: Aspect): number {
  if (aspect === "9:16") return 9 / 16;
  if (aspect === "1:1") return 1;
  return 16 / 9;
}

export function cropWindow(
  srcW: number,
  srcH: number,
  aspect: Aspect,
  face: { width: number; height: number } | null,
): { width: number; height: number } {
  const ratio = aspectRatio(aspect);
  let height = srcH;
  if (face && face.height > 0) {
    height = clamp(face.height * 2.7, srcH * 0.52, srcH * 0.92);
  }
  let width = height * ratio;
  if (width > srcW) {
    width = srcW;
    height = width / ratio;
  }
  if (height > srcH) {
    height = srcH;
    width = Math.min(srcW, height * ratio);
  }
  return {
    width: Math.max(2, Math.min(even(srcW), even(width))),
    height: Math.max(2, Math.min(even(srcH), even(height))),
  };
}

function centerOf(box: FaceBox): { x: number; y: number; area: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2, area: Math.max(1, box.w * box.h) };
}

/** Pick a stable subject and limit how fast the frame can pan. */
export function followSubject(samples: DetectSample[], srcW: number, srcH: number): SubjectPoint[] {
  const tracks: LiveTrack[] = [];
  let nextId = 1;
  let activeId = 0;
  let lastFace: SubjectPoint | null = null;
  let cursor = { x: srcW / 2, y: srcH / 2, t: 0 };
  const points: SubjectPoint[] = [];

  const ordered = [...samples].sort((a, b) => a.t - b.t);
  for (const sample of ordered) {
    const faces = sample.faces.map(centerOf);
    const matchDistance = Math.max(48, srcW * 0.18);
    const used = new Set<number>();
    for (const face of faces) {
      let best = -1;
      let bestDist = matchDistance;
      tracks.forEach((track, index) => {
        if (used.has(track.id)) return;
        const dist = Math.hypot(track.cx - face.x, track.cy - face.y);
        if (dist < bestDist) {
          best = index;
          bestDist = dist;
        }
      });
      if (best >= 0) {
        const previous = tracks[best];
        used.add(previous.id);
        tracks[best] = { ...previous, cx: face.x, cy: face.y, area: face.area, seen: sample.t };
      } else {
        const created = { id: nextId, cx: face.x, cy: face.y, area: face.area, lead: 0, seen: sample.t };
        nextId += 1;
        tracks.push(created);
        used.add(created.id);
      }
    }

    for (let index = tracks.length - 1; index >= 0; index -= 1) {
      if (!used.has(tracks[index].id) && sample.t - tracks[index].seen > 1.6) tracks.splice(index, 1);
    }
    if (!tracks.some((track) => track.id === activeId)) activeId = 0;

    let target: { x: number; y: number } | null = null;
    if (tracks.length) {
      if (!activeId) activeId = tracks.reduce((best, track) => track.area > best.area ? track : best).id;
      const active = tracks.find((track) => track.id === activeId) ?? tracks[0];
      activeId = active.id;
      tracks.forEach((track) => {
        track.lead = track.id !== active.id && track.area > active.area * 1.35 ? track.lead + 1 : 0;
      });
      const challenger = tracks.find((track) => track.lead >= 3);
      if (challenger) activeId = challenger.id;
      const chosen = tracks.find((track) => track.id === activeId) ?? active;
      target = { x: chosen.cx, y: chosen.cy };
      lastFace = { t: sample.t, x: chosen.cx, y: chosen.cy };
    } else if (lastFace && sample.t - lastFace.t < 1.6) {
      target = { x: lastFace.x, y: lastFace.y };
    } else if (sample.motion) {
      target = sample.motion;
    } else {
      target = { x: srcW / 2, y: srcH / 2 };
    }

    const dt = points.length ? Math.max(0.05, sample.t - cursor.t) : 0;
    cursor = points.length
      ? { t: sample.t, x: approach(cursor.x, target.x, srcW, dt), y: approach(cursor.y, target.y, srcH, dt) }
      : { t: sample.t, x: target.x, y: target.y };
    points.push({ t: round(sample.t), x: round(cursor.x), y: round(cursor.y) });
  }

  return points;
}

function approach(current: number, target: number, span: number, dt: number): number {
  const delta = target - current;
  const gap = Math.abs(delta) / Math.max(1, span);
  if (gap < 0.012) return current;
  const speed = (gap > 0.12 ? 0.85 : 0.28) * span;
  const step = speed * dt;
  return current + clamp(delta, -step, step);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function faceStats(samples: DetectSample[]): { width: number; height: number } | null {
  const boxes = samples.flatMap((sample) => sample.faces);
  if (!boxes.length) return null;
  const widths = boxes.map((box) => box.w).sort((a, b) => a - b);
  const heights = boxes.map((box) => box.h).sort((a, b) => a - b);
  const mid = Math.floor(widths.length / 2);
  return { width: widths[mid], height: heights[mid] };
}

export function planCrop(
  track: SubjectTrack,
  aspect: Aspect,
  start: number,
  end: number,
): CropPlan {
  const srcW = Math.max(2, track.width);
  const srcH = Math.max(2, track.height);
  const window = cropWindow(srcW, srcH, aspect, track.face);
  const span = Math.max(0.2, end - start);
  const keys: CropKey[] = [];
  for (let time = 0; time <= span + 0.001; time += 0.2) {
    const point = pointAt(track.points, start + time, srcW, srcH);
    keys.push({
      t: round(time),
      ...originFor(point, window, srcW, srcH, track.face),
    });
  }
  return { width: window.width, height: window.height, keys };
}

function pointAt(points: SubjectPoint[], time: number, srcW: number, srcH: number): SubjectPoint {
  if (!points.length) return { t: time, x: srcW / 2, y: srcH / 2 };
  if (time <= points[0].t) return points[0];
  const last = points[points.length - 1];
  if (time >= last.t) return last;
  const next = points.findIndex((point) => point.t >= time);
  const b = points[next];
  const a = points[next - 1];
  const mix = (time - a.t) / Math.max(0.001, b.t - a.t);
  return {
    t: time,
    x: a.x + (b.x - a.x) * mix,
    y: a.y + (b.y - a.y) * mix,
  };
}

function originFor(
  point: SubjectPoint,
  window: { width: number; height: number },
  srcW: number,
  srcH: number,
  face: { width: number; height: number } | null,
): { x: number; y: number } {
  let x = point.x - window.width * 0.42;
  let y = point.y - window.height * 0.36;
  if (face) {
    const padX = Math.max(36, face.width * 1.8);
    const padY = Math.max(48, face.height * 2.2);
    const left = point.x - face.width / 2;
    const right = point.x + face.width / 2;
    const top = point.y - face.height / 2;
    const bottom = point.y + face.height / 2;
    if (x > left - padX) x = left - padX;
    if (x + window.width < right + padX) x = right + padX - window.width;
    if (y > top - padY) y = top - padY;
    if (y + window.height < bottom + padY) y = bottom + padY - window.height;
  }
  return {
    x: clamp(even(x), 0, Math.max(0, even(srcW - window.width))),
    y: clamp(even(y), 0, Math.max(0, even(srcH - window.height))),
  };
}

/** Map a subject point into the CSS object-position that keeps it framed. */
export function previewFocus(
  track: SubjectTrack,
  time: number,
  aspect: Aspect,
): { x: number; y: number } {
  const point = pointAt(track.points, time, track.width, track.height);
  const window = cropWindow(track.width, track.height, aspect, track.face);
  const visibleX = window.width / track.width;
  const visibleY = window.height / track.height;
  const nx = point.x / track.width;
  const ny = point.y / track.height;
  const x = visibleX >= 0.98 ? 0.5 : clamp((nx - visibleX / 2) / (1 - visibleX), 0, 1);
  const y = visibleY >= 0.98 ? 0.5 : clamp((ny - visibleY * 0.38) / (1 - visibleY), 0, 1);
  return { x, y };
}
