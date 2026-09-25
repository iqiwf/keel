import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clipPatchSchema, parseVideoUrl } from "../lib/validation";
import { cuesFromWords } from "../lib/captions";
import { highlightsFromSpeech, sanitizeDrafts } from "../lib/highlights";
import { canMark, canStop, claim, release, requestCancel, wasCancelled, forgetCancel, sourceBusy } from "../lib/jobs";
import { cutsMatch } from "../lib/pipeline";
import { probeMedia, rmsOfInt16, scanEnergy } from "../lib/video/ffmpeg";
import { parseEnergy, prepareWindows, selectWindows } from "../lib/video/windows";
import { cropWindow, followSubject, planCrop, previewBox } from "../lib/video/reframe";
import { alignWords, clampWordsToWindows, localModelKey, readTranscript, saveTranscript, transcriptMatches } from "../lib/video/speech";
import { readTrack, saveTrack, trackMatches } from "../lib/video/subjects";
import { getClip, getProject, patchClip, saveClip, saveProject, updateProject, writeBounded } from "../lib/store";
import { downloadCapMb, removeDownloadLeftovers, withinDownloadCap } from "../lib/video/youtube";

process.env.KEEL_MAX_JOBS = "8";

test("clip patch rejects non-finite numbers and invalid cue timing", () => {
  assert.throws(() => clipPatchSchema.parse({ start: Number.NaN }));
  assert.throws(() => clipPatchSchema.parse({ end: Number.POSITIVE_INFINITY }));
  const parsed = clipPatchSchema.parse({
    cues: [{ start: 2, end: 1, text: "bad timing" }],
  });
  assert.equal(parsed.cues?.[0].end, 1);
});

test("youtube validation does not accept arbitrary youtube paths or playlist-only short links", () => {
  assert.throws(() => parseVideoUrl("https://www.youtube.com/feed/subscriptions"));
  assert.throws(() => parseVideoUrl("https://youtu.be/dQw4w9WgXcQ?list=PL123456"));
  assert.doesNotThrow(() => parseVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"));
});

test("caption cue generation clips timestamps to the selected cut", () => {
  const cues = cuesFromWords([
    { text: "before", start: 0, end: 0.8 },
    { text: "inside", start: 2, end: 2.5 },
    { text: "after", start: 5, end: 5.5 },
  ], 1, 4);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "inside");
  assert.ok(cues[0].start >= 1 && cues[0].end <= 4);
});

test("reframe crop dimensions remain valid for every supported aspect", () => {
  for (const aspect of ["9:16", "1:1", "16:9"] as const) {
    const window = cropWindow(1920, 1080, aspect, { width: 140, height: 180 });
    assert.ok(window.width > 1 && window.height > 1);
    assert.equal(window.width % 2, 0);
    assert.equal(window.height % 2, 0);
  }
});

test("highlights prefer a question with a point over filler", () => {
  const words = [
    ...["um", "uh", "like", "um"].map((text, index) => ({ text, start: 2 + index * 0.4, end: 2.3 + index * 0.4 })),
    ...["Why", "does", "this", "matter?"].map((text, index) => ({ text, start: 20 + index * 0.35, end: 20.3 + index * 0.35 })),
  ];
  const clips = highlightsFromSpeech(40, 12, { language: "en", text: words.map((word) => word.text).join(" "), words });
  assert.ok(clips.some((clip) => clip.start > 10), `question was not selected: ${clips.map((clip) => clip.start).join(",")}`);
  const question = clips.find((clip) => clip.start > 10);
  const filler = clips.find((clip) => clip.start <= 10);
  if (question && filler) assert.ok(question.score >= filler.score);
});

test("highlights prefer a clean opening over a long sparse passage", () => {
  const words = [
    ...["Wait", "for", "this."].map((text, index) => ({ text, start: 1 + index * 0.4, end: 1.3 + index * 0.4 })),
    ...Array.from({ length: 12 }, (_, index) => ({ text: "um", start: 20 + index * 2.2, end: 20.3 + index * 2.2 })),
  ];
  const [best] = highlightsFromSpeech(50, 15, { language: "en", text: words.map((word) => word.text).join(" "), words });
  assert.ok(best.start < 8, `picked the sparse passage at ${best.start}`);
  assert.ok(best.end - best.start >= 3);
});

test("a lost face holds its last position instead of jumping to distant motion", () => {
  const samples = [
    { t: 0, faces: [{ x: 80, y: 100, w: 80, h: 90 }], motion: null },
    { t: 0.5, faces: [], motion: { x: 900, y: 400 } },
    { t: 1.2, faces: [], motion: { x: 920, y: 420 } },
  ];
  const points = followSubject(samples, 1280, 720);
  assert.ok(points[2].x < 300, `jumped to ${points[2].x}`);
});

test("long-video windows stay on the loud parts and cover far less than the runtime", () => {
  const bins = [
    { t: 10, rms: -80 },
    { t: 70, rms: -18 },
    { t: 71, rms: -16 },
    { t: 200, rms: -90 },
    { t: 2400, rms: -17 },
  ];
  const windows = selectWindows(bins, 50 * 60, 30);
  const covered = windows.reduce((sum, window) => sum + (window.end - window.start), 0);
  assert.ok(covered < 8 * 60, `covered ${covered}`);
  assert.ok(windows.some((window) => window.start <= 70 && window.end >= 72));
  assert.ok(windows.some((window) => window.start <= 2400 && window.end >= 2401));
  assert.ok(windows[windows.length - 1].start > 20 * 60);
  assert.equal(parseEnergy("pts_time:3\nlavfi.astats.Overall.RMS_level=-12.5").length, 1);
});

test("reframe plan stays on the source bounds for a moving subject", () => {
  const track = {
    width: 1280,
    height: 720,
    face: { width: 120, height: 150 },
    points: [
      { t: 0, x: 100, y: 360 },
      { t: 2, x: 640, y: 360 },
      { t: 4, x: 1180, y: 360 },
    ],
  };
  const plan = planCrop(track, "9:16", 0.5, 3.5);
  for (const key of plan.keys) {
    assert.ok(key.x >= 0 && key.y >= 0);
    assert.ok(key.x + plan.width <= track.width);
    assert.ok(key.y + plan.height <= track.height);
  }
});

test("clip-relative whisper words are shifted onto the source windows", () => {
  const windows = [{ start: 100, end: 130 }, { start: 500, end: 530 }];
  const shifted = alignWords([
    { text: "first", start: 0.4, end: 0.8 },
    { text: "later", start: 30.2, end: 30.6 },
  ], windows, "relative");
  assert.ok(Math.abs(shifted[0].start - 100.4) < 0.01);
  assert.ok(Math.abs(shifted[1].start - 500.2) < 0.01);
  const absolute = alignWords([
    { text: "kept", start: 104, end: 104.4 },
    { text: "also", start: 510, end: 510.4 },
  ], windows);
  assert.equal(absolute[0].start, 104);
  assert.equal(absolute[1].start, 510);
  const full = alignWords([
    { text: "open", start: 1, end: 1.4 },
    { text: "far", start: 4000, end: 4000.4 },
  ], windows);
  assert.equal(full[0].start, 1);
  assert.equal(full[1].start, 4000);
});

test("a quiet but audible band is still selected, and silence is not", () => {
  const bins = [
    { t: 20, rms: -90 },
    { t: 1500, rms: -50 },
    { t: 1501, rms: -48 },
  ];
  const windows = selectWindows(bins, 50 * 60, 30);
  assert.ok(windows.some((window) => window.start <= 1500 && window.end >= 1501), JSON.stringify(windows));
  assert.ok(!windows.some((window) => window.start <= 20 && window.end >= 21 && window.end < 400));
  const covered = windows.reduce((sum, window) => sum + (window.end - window.start), 0);
  assert.ok(covered < 8 * 60);
});

test("a second distinct passage in the same stretch is still covered", () => {
  const bins = [
    ...[1600, 1601, 1602, 1603].map((t) => ({ t, rms: -18 })),
    ...[1850, 1851, 1852, 1853].map((t) => ({ t, rms: -20 })),
  ];
  const windows = selectWindows(bins, 50 * 60, 30);
  assert.ok(windows.some((window) => window.start <= 1600 && window.end >= 1603), JSON.stringify(windows));
  assert.ok(windows.some((window) => window.start <= 1850 && window.end >= 1853), JSON.stringify(windows));
});

test("overlapping windows are merged and a silent soundtrack is not scanned in full", () => {
  const merged = prepareWindows([
    { start: -2, end: 10 },
    { start: 9.2, end: 20 },
    { start: 100, end: 101 },
    { start: 400, end: 500 },
  ], 120);
  assert.deepEqual(merged, [
    { start: 0, end: 20 },
    { start: 100, end: 101 },
  ]);
  const silent = selectWindows([
    { t: 10, rms: -90 },
    { t: 400, rms: -88 },
    { t: 2000, rms: -91 },
  ], 50 * 60, 30);
  assert.deepEqual(silent, []);
  const quietSpeech = selectWindows([
    { t: 30, rms: -90 },
    { t: 800, rms: -70 },
    { t: 801, rms: -68 },
    { t: 802, rms: -69 },
    { t: 803, rms: -70 },
  ], 50 * 60, 30);
  assert.ok(quietSpeech.some((window) => window.start <= 800 && window.end >= 803), JSON.stringify(quietSpeech));
});

test("words that spill outside a window are trimmed, and a language change misses the cache", () => {
  const windows = [{ start: 100, end: 130 }, { start: 500, end: 520 }];
  const clamped = clampWordsToWindows([
    { text: "early", start: 1, end: 1.4 },
    { text: "inside", start: 104, end: 104.4 },
    { text: "spill", start: 128, end: 140 },
    { text: "gap", start: 200, end: 201 },
  ], windows);
  assert.deepEqual(clamped.map((word) => word.text), ["inside", "spill"]);
  assert.equal(clamped[1].end, 130);
  const previous = process.env.WHISPER_LANGUAGE;
  delete process.env.WHISPER_LANGUAGE;
  const auto = localModelKey();
  process.env.WHISPER_LANGUAGE = "id";
  const indonesian = localModelKey();
  if (previous === undefined) delete process.env.WHISPER_LANGUAGE;
  else process.env.WHISPER_LANGUAGE = previous;
  assert.notEqual(auto, indonesian);
  assert.match(indonesian, /:id:2$/);
  assert.match(auto, /:auto:2$/);
});

test("malformed model cuts are dropped and a zero score is kept", () => {
  const drafts = sanitizeDrafts([
    { title: "Ok", hook: "", reason: "", score: 0, start: 4, end: 12, captionText: "line" },
    { title: "Bad", hook: "", reason: "", score: 0.9, start: Number.NaN, end: 8, captionText: "" },
    { title: "Backwards", hook: "", reason: "", score: 2, start: 20, end: 10, captionText: "" },
    null,
  ], 40);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].score, 0);
  assert.equal(drafts[0].start, 4);
  assert.equal(drafts[0].end, 12);
  assert.deepEqual(sanitizeDrafts([{ title: "Bad score", hook: "", reason: "", score: Number.NaN, start: 4, end: 12, captionText: "" }], 40), []);
  assert.deepEqual(sanitizeDrafts("nope", 40), []);
});

test("a stale analyzing status can be marked again and still stopped", () => {
  assert.equal(sourceBusy(false), false);
  assert.equal(sourceBusy(true), true);
  assert.equal(canMark(12, false), true);
  assert.equal(canMark(12, true), false);
  assert.equal(canMark(0, false), false);
  assert.equal(canStop("analyzing", false), true);
  assert.equal(canStop("draft", false), false);
  assert.equal(canStop("draft", true), true);
});

test("a failed download does not leave fragments behind", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-yt-"));
  const output = path.join(root, "prj_demo.mp4");
  fs.writeFileSync(output, "finished");
  fs.writeFileSync(path.join(root, "prj_demo.mp4.part"), "partial");
  fs.writeFileSync(path.join(root, "prj_demo.f137.mp4"), "fragment");
  fs.writeFileSync(path.join(root, "prj_other.mp4"), "keep");
  removeDownloadLeftovers(output);
  assert.equal(fs.existsSync(output), true);
  assert.equal(fs.existsSync(path.join(root, "prj_demo.mp4.part")), false);
  assert.equal(fs.existsSync(path.join(root, "prj_demo.f137.mp4")), false);
  assert.equal(fs.existsSync(path.join(root, "prj_other.mp4")), true);
  fs.rmSync(root, { recursive: true, force: true });
  const cap = downloadCapMb() * 1024 * 1024;
  assert.equal(withinDownloadCap(cap), true);
  assert.equal(withinDownloadCap(cap + 1), false);
  assert.equal(withinDownloadCap(Number.NaN), false);
});

test("a new shot after a gap is framed immediately instead of panning across the cut", () => {
  const points = followSubject([
    { t: 0, faces: [{ x: 40, y: 80, w: 80, h: 90 }], motion: null },
    { t: 0.4, faces: [{ x: 48, y: 80, w: 80, h: 90 }], motion: null },
    { t: 40, faces: [{ x: 800, y: 100, w: 90, h: 100 }], motion: null },
  ], 1280, 720);
  assert.ok(points[2].x > 700, `held the old shot at ${points[2].x}`);
});

test("a printed cut is stale when only the cues or caption style changed", () => {
  const base = {
    start: 1,
    end: 8,
    aspect: "9:16",
    captionStyle: "ledger",
    captionText: "hello there",
    cues: [{ start: 1, end: 2, text: "hello" }],
  };
  assert.equal(cutsMatch(base, { ...base }), true);
  assert.equal(cutsMatch(base, { ...base, captionStyle: "ticker" }), false);
  assert.equal(cutsMatch(base, { ...base, cues: [{ start: 1, end: 2, text: "hello!" }] }), false);
  assert.equal(cutsMatch(base, { ...base, cues: [{ start: 1.2, end: 2, text: "hello" }] }), false);
});

test("preview placement keeps the crop aspect and the same scale on both axes", () => {
  const source = { width: 1920, height: 1080 };
  const crop = { x: 700, y: 0, width: 608, height: 1080 };
  const box = previewBox(source.width, source.height, crop, "9:16");
  const out = 9 / 16;
  const left = box.left + (crop.x / source.width) * box.width;
  const right = box.left + ((crop.x + crop.width) / source.width) * box.width;
  const top = box.top + (crop.y / source.height) * box.height;
  const bottom = box.top + ((crop.y + crop.height) / source.height) * box.height;
  const xScale = (right - left) / crop.width;
  const yScale = (bottom - top) / crop.height;
  assert.ok(Math.abs(xScale * out - yScale) < 0.02, `scales ${xScale} ${yScale}`);
  assert.ok(left >= -0.05 && right <= 100.05, `x ${left}..${right}`);
  assert.ok(top >= -0.05 && bottom <= 100.05, `y ${top}..${bottom}`);
  assert.ok(right - left > 90, `crop width ${right - left}`);
});

test("pcm loudness treats silence and a full-scale tone differently", () => {
  assert.equal(rmsOfInt16(Buffer.alloc(1600)), -100);
  const tone = Buffer.alloc(1600);
  for (let index = 0; index < 800; index += 1) {
    const sample = Math.round(32767 * Math.sin((index / 800) * Math.PI * 8));
    tone.writeInt16LE(sample, index * 2);
  }
  const level = rmsOfInt16(tone);
  assert.ok(level > -6 && level < -1, `expected near -3 dB, got ${level}`);
});

test("energy scan reports a tone louder than the silence before it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-energy-"));
  const source = path.join(root, "tone.wav");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "aevalsrc=0:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1",
    source,
  ]);
  const bins = await scanEnergy(source);
  assert.ok(bins.length >= 2, `bins ${bins.length}`);
  assert.ok(bins[0].t === 0 && bins[0].rms < -40, `lead bin ${bins[0].rms}`);
  const tone = bins.find((bin) => bin.t >= 1);
  assert.ok(tone && tone.rms > -30 && tone.rms > bins[0].rms + 30, JSON.stringify(bins));
  fs.rmSync(root, { recursive: true, force: true });
});

test("an upload larger than the cap is not kept", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-upload-"));
  const target = path.join(root, "too-big.mp4");
  const file = new File([new Uint8Array(64)], "too-big.mp4", { type: "video/mp4" });
  await assert.rejects(() => writeBounded(file, target, 16));
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readdirSync(root).length, 0);
  const small = path.join(root, "ok.mp4");
  await writeBounded(new File([new Uint8Array(8)], "ok.mp4", { type: "video/mp4" }), small, 16);
  assert.equal(fs.statSync(small).size, 8);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stopping a mark is remembered until the job notices", () => {
  requestCancel("prj_stop");
  assert.equal(wasCancelled("prj_stop"), true);
  forgetCancel("prj_stop");
  assert.equal(wasCancelled("prj_stop"), false);
});

test("a file with no picture is refused before any cut is made", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-probe-"));
  const source = path.join(root, "tone.wav");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("ffmpeg", ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]);
  await assert.rejects(() => probeMedia(source), /no picture/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a second job for the same source is refused until the first releases", () => {
  assert.equal(claim("prj_lock_a"), true);
  assert.equal(claim("prj_lock_a"), false);
  assert.equal(claim("prj_lock_b"), true);
  release("prj_lock_a");
  assert.equal(claim("prj_lock_a"), true);
  release("prj_lock_a");
  release("prj_lock_b");
});

test("track and transcript caches ignore a changed source and a corrupt file", async () => {
  const previous = process.env.DATA_DIR;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-cache-"));
  process.env.DATA_DIR = root;
  try {
    const track = {
      width: 100,
      height: 100,
      face: null,
      points: [{ t: 0, x: 50, y: 50 }],
      fingerprint: "10:1",
      coverage: [{ start: 1, end: 4 }],
    };
    saveTrack("prj_cache", track);
    assert.equal(trackMatches(readTrack("prj_cache"), "10:1", [{ start: 1, end: 4 }]), true);
    assert.equal(trackMatches(readTrack("prj_cache"), "10:2", [{ start: 1, end: 4 }]), false);
    assert.equal(trackMatches(readTrack("prj_cache"), "10:1"), false);
    assert.equal(trackMatches({ ...track, coverage: undefined }, "10:1", [{ start: 1, end: 4 }]), false);
    fs.writeFileSync(path.join(root, "analysis", "prj_cache.json"), "{not json");
    assert.equal(readTrack("prj_cache"), null);
    const transcript = { language: "en", text: "hello", words: [{ text: "hello", start: 1, end: 1.4 }] };
    saveTranscript("prj_cache", { fingerprint: "10:1", model: "local:small", scope: "full", windows: [], transcript });
    const cached = readTranscript("prj_cache");
    assert.equal(transcriptMatches(cached, "10:1", "local:small"), true);
    assert.equal(transcriptMatches(cached, "10:1", "local:small", [{ start: 2, end: 6 }]), false);
    assert.equal(transcriptMatches(cached, "99:1", "local:small"), false);
    saveTranscript("prj_cache", {
      fingerprint: "10:1",
      model: "local:small",
      scope: "windows",
      windows: [{ start: 2, end: 6 }],
      transcript,
    });
    const windowed = readTranscript("prj_cache");
    assert.equal(transcriptMatches(windowed, "10:1", "local:small", [{ start: 2, end: 6 }]), true);
    assert.equal(transcriptMatches(windowed, "10:1", "local:small"), false);
    saveTranscript("prj_cache", {
      fingerprint: "10:1",
      model: "local:small",
      scope: "windows",
      windows: [{ start: 2, end: 6 }],
      transcript: { ...transcript, words: [{ text: "outside", start: 90, end: 91 }] },
    });
    assert.equal(transcriptMatches(readTranscript("prj_cache"), "10:1", "local:small", [{ start: 2, end: 6 }]), false);
    assert.equal(fs.readdirSync(path.join(root, "analysis")).some((name) => name.endsWith(".tmp")), false);
    saveProject({
      id: "prj_cache",
      title: "Cache",
      source: "upload",
      sourceLabel: "cache.mp4",
      fileName: "prj_cache.mp4",
      duration: 12,
      status: "draft",
      error: null,
      progress: 100,
      stage: "Ready",
      createdAt: new Date().toISOString(),
      transcript: null,
      warning: null,
    });
    saveClip({
      id: "clp_cache",
      projectId: "prj_cache",
      title: "Old",
      hook: "",
      reason: "",
      score: 0.5,
      start: 1,
      end: 6,
      aspect: "9:16",
      captionStyle: "ledger",
      captionText: "old",
      cues: [],
      status: "ready",
      exportName: null,
      error: null,
      createdAt: new Date().toISOString(),
    });
    const stale = getClip("clp_cache");
    updateProject("prj_cache", { progress: 40, stage: "Reading" });
    const merged = patchClip("clp_cache", { title: "Kept" });
    assert.equal(merged?.title, "Kept");
    assert.equal(merged?.captionText, "old");
    assert.equal(getProject("prj_cache")?.progress, 40);
    assert.equal(getProject("prj_cache")?.stage, "Reading");
    saveClip({ ...stale!, title: "Stale" });
    assert.equal(getProject("prj_cache")?.progress, 40);
    patchClip("clp_cache", { captionText: "newer" });
    assert.equal(getClip("clp_cache")?.captionText, "newer");
    assert.equal(claim("prj_cache"), true);
    try {
      const analyze = await import("../app/api/projects/[id]/analyze/route");
      const refused = await analyze.POST(
        new Request("http://localhost", { method: "POST", body: JSON.stringify({ targetSeconds: 15 }) }),
        { params: Promise.resolve({ id: "prj_cache" }) },
      );
      assert.equal(refused.status, 409);
    } finally {
      release("prj_cache");
    }
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
