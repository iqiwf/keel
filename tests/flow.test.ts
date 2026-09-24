import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mockProvider } from "../lib/ai/mock";
import { renderClip } from "../lib/video/ffmpeg";
import { assertVideoFile, parseVideoUrl } from "../lib/validation";

test("accepts public YouTube links and rejects other hosts", () => {
  const watch = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(watch.hostname, "www.youtube.com");
  const short = parseVideoUrl("https://youtu.be/dQw4w9WgXcQ");
  assert.equal(short.hostname, "youtu.be");
  assert.throws(() => parseVideoUrl("https://example.com/watch?v=dQw4w9WgXcQ"));
  assert.throws(() => parseVideoUrl("file:///C:/secret.mp4"));
  assert.throws(() => parseVideoUrl("https://www.youtube.com/feed/subscriptions"));
});

test("rejects unexpected upload types and empty files", () => {
  assert.equal(assertVideoFile("talk.mp4", "video/mp4", 1200, 5_000_000), ".mp4");
  assert.throws(() => assertVideoFile("notes.exe", "application/octet-stream", 100, 5_000_000));
  assert.throws(() => assertVideoFile("talk.mp4", "video/mp4", 0, 5_000_000));
  assert.throws(() => assertVideoFile("talk.mp4", "video/mp4", 9_000, 1_000));
});

test("mock marker returns in-range cuts and a transcript", async () => {
  const transcript = await mockProvider.transcribe({ title: "Bench test", duration: 48, targetSeconds: 15 });
  assert.ok(transcript.words.length > 3);
  assert.ok(transcript.words.every((word) => word.end <= 48.01));
  const clips = await mockProvider.findHighlights(
    { title: "Bench test", duration: 48, targetSeconds: 15 },
    transcript,
  );
  assert.ok(clips.length >= 2);
  for (const clip of clips) {
    assert.ok(clip.start >= 0);
    assert.ok(clip.end > clip.start);
    assert.ok(clip.end <= 48.01);
    assert.ok(clip.captionText.length > 0);
  }
});

test("prints a reframed captioned cut with ffmpeg", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-"));
  const source = path.join(root, "master.mp4");
  const output = path.join(root, "cut.mp4");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=12:duration=6",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=6",
    "-shortest",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    source,
  ]);
  await renderClip({
    source,
    output,
    start: 1,
    end: 4,
    aspect: "9:16",
    caption: "Keep this passage",
    style: "ledger",
  });
  const stat = fs.statSync(output);
  assert.ok(stat.size > 1000);
  fs.rmSync(root, { recursive: true, force: true });
});

test("upload, mark, trim, and print through the app routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-flow-"));
  process.env.DATA_DIR = root;
  process.env.AI_PROVIDER = "mock";
  const source = path.join(root, "sample.mp4");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=0x223344:s=640x360:d=8",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=8",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ]);
  const file = new File([fs.readFileSync(source)], "sample.mp4", { type: "video/mp4" });
  const form = new FormData();
  form.set("file", file);
  const { POST } = await import("../app/api/projects/route");
  const { GET } = await import("../app/api/projects/[id]/route");
  const analyze = await import("../app/api/projects/[id]/analyze/route");
  const patcher = await import("../app/api/clips/[id]/route");
  const printer = await import("../app/api/clips/[id]/export/route");
  const created = await POST(new Request("http://localhost/api/projects", { method: "POST", body: form }));
  assert.equal(created.status, 202);
  const { project } = await created.json() as { project: { id: string } };
  const ready = await waitFor(async () => {
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: project.id }) });
    const body = await response.json() as { project: { status: string; duration: number; error: string | null } };
    if (body.project.status === "failed") throw new Error(body.project.error || "ingest failed");
    return body.project.duration > 0 ? body : null;
  });
  assert.ok(ready.project.duration > 1);

  const marked = await analyze.POST(
    new Request("http://localhost", { method: "POST", body: JSON.stringify({ targetSeconds: 15 }) }),
    { params: Promise.resolve({ id: project.id }) },
  );
  assert.equal(marked.status, 202);
  const done = await waitFor(async () => {
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: project.id }) });
    const body = await response.json() as { project: { status: string; error: string | null }; clips: { id: string; start: number; end: number }[] };
    if (body.project.status === "failed") throw new Error(body.project.error || "analyze failed");
    return body.project.status === "ready" && body.clips.length > 0 ? body : null;
  });
  const clip = done.clips[0];
  const edited = await patcher.PATCH(
    new Request("http://localhost", {
      method: "PATCH",
      body: JSON.stringify({
        title: "Bench pass",
        start: 0.4,
        end: 3.8,
        aspect: "1:1",
        captionStyle: "ticker",
        captionText: "Say it plainly",
      }),
    }),
    { params: Promise.resolve({ id: clip.id }) },
  );
  assert.equal(edited.status, 200);
  const printing = await printer.POST(new Request("http://localhost"), { params: Promise.resolve({ id: clip.id }) });
  assert.equal(printing.status, 202);
  const printed = await waitFor(async () => {
    const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: project.id }) });
    const body = await response.json() as { clips: { id: string; status: string; exportName: string | null; error: string | null; aspect: string }[] };
    const current = body.clips.find((item) => item.id === clip.id);
    if (current?.status === "failed") throw new Error(current.error || "export failed");
    return current?.status === "exported" ? current : null;
  });
  const exported = path.join(root, "exports", printed.exportName || "");
  assert.equal(printed.aspect, "1:1");
  assert.ok(fs.statSync(exported).size > 1000);
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the cut flow.");
}
