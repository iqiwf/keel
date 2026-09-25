import assert from "node:assert/strict";
import test from "node:test";
import { clipPatchSchema, parseVideoUrl } from "../lib/validation";
import { cuesFromWords } from "../lib/captions";
import { cropWindow, planCrop } from "../lib/video/reframe";

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
