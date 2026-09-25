import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mockProvider } from "../lib/ai/mock";
import { cuesFromWords } from "../lib/captions";
import { renderClip } from "../lib/video/ffmpeg";
import { followSubject, planCrop } from "../lib/video/reframe";
import { detectTrack } from "../lib/video/subjects";
import { transcribeFile } from "../lib/video/speech";
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

test("the frame follows a subject across the picture and ignores tiny jitter", () => {
  const samples = Array.from({ length: 13 }, (_, index) => ({
    t: index * 0.25,
    faces: [{ x: 80 + index * 60, y: 80, w: 90, h: 110 }],
    motion: null,
  }));
  const points = followSubject(samples, 960, 540);
  assert.ok(points[points.length - 1].x > points[0].x + 400);
  assert.ok(Math.abs(points[points.length - 1].x - (80 + 12 * 60 + 45)) < 180);
  const jitter = followSubject([
    { t: 0, faces: [{ x: 400, y: 80, w: 80, h: 80 }], motion: null },
    { t: 0.25, faces: [{ x: 404, y: 82, w: 80, h: 80 }], motion: null },
    { t: 0.5, faces: [{ x: 398, y: 79, w: 80, h: 80 }], motion: null },
  ], 960, 540);
  assert.ok(Math.abs(jitter[2].x - jitter[0].x) < 30);
});

test("a clearly larger second speaker takes over, then holds", () => {
  const samples = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3].map((t) => ({
    t,
    faces: t < 1
      ? [{ x: 40, y: 60, w: 80, h: 80 }]
      : [{ x: 40, y: 60, w: 70, h: 70 }, { x: 700, y: 50, w: 150, h: 160 }],
    motion: null,
  }));
  const points = followSubject(samples, 960, 540);
  assert.ok(points[2].x < 250);
  assert.ok(points[points.length - 1].x > 700);
  const jump = Math.max(...points.slice(1).map((point, index) => Math.abs(point.x - points[index].x)));
  assert.ok(jump < 250, `pan jumped by ${jump}`);
});

test("a cut that starts late still moves its crop on the output clock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-late-"));
  const source = path.join(root, "src.mp4");
  const output = path.join(root, "cut.mp4");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=640x360:d=4:r=10",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-vf", "drawbox=x=20:y=40:w=80:h=80:color=white:t=fill",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ]);
  await renderClip({
    source,
    output,
    start: 1.2,
    end: 2.4,
    aspect: "9:16",
    style: "ticker",
    crop: {
      width: 160,
      height: 360,
      keys: [
        { t: 0, x: 0, y: 0 },
        { t: 0.45, x: 400, y: 0 },
      ],
    },
    cues: [{ start: 1.3, end: 1.8, text: "Late line" }],
  });
  const early = await brightCount(output, 0.15);
  const late = await brightCount(output, 0.8);
  assert.ok(early > 1000, `opening frame lost the subject (${early})`);
  assert.ok(late < 200, `crop did not move after the start (${late})`);
  fs.rmSync(root, { recursive: true, force: true });
});

async function brightCount(video: string, time: number): Promise<number> {
  const png = `${video}.${time}.png`;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("ffmpeg", ["-y", "-ss", String(time), "-i", video, "-frames:v", "1", png]);
  const { stdout } = await exec("python", ["-c", "import cv2,sys; img=cv2.imread(sys.argv[1],0); print(int((img>200).sum()))", png]);
  return Number(stdout.trim());
}

test("caption cues stay inside the cut and keep their spoken times", () => {
  const cues = cuesFromWords([
    { text: "Ini", start: 1.0, end: 1.3 },
    { text: "adalah", start: 1.3, end: 1.7 },
    { text: "uji", start: 1.7, end: 2.0 },
    { text: "ucapan.", start: 2.0, end: 2.5 },
    { text: "Lanjut", start: 4.2, end: 4.6 },
  ], 0.8, 3.2);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Ini adalah uji ucapan.");
  assert.ok(cues[0].start >= 0.8 && cues[0].end <= 3.2);
});

test("a moving subject stays inside the printed 9:16 frame", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-track-"));
  const source = path.join(root, "move.mp4");
  const output = path.join(root, "cut.mp4");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=960x540:d=4:r=12",
    "-f", "lavfi", "-i", "color=c=white:s=140x150:d=4:r=12",
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
    "-filter_complex", "overlay=x='30+180*t':y=190",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
  ]);
  const track = await detectTrack(source);
  const plan = planCrop(track, "9:16", 0.2, 3.6);
  assert.ok(plan.keys[plan.keys.length - 1].x > plan.keys[0].x + 120, "crop should travel with the subject");
  await renderClip({
    source,
    output,
    start: 0.2,
    end: 3.6,
    aspect: "9:16",
    style: "ledger",
    caption: "",
    cues: [{ start: 0.4, end: 1.2, text: "Keep this passage" }],
    crop: plan,
  });
  const early = await brightCenter(exec, output, 0.35, root);
  const late = await brightCenter(exec, output, 2.8, root);
  assert.ok(early.count > 400, "subject missing at the start of the export");
  assert.ok(late.count > 400, "subject missing at the end of the export");
  assert.ok(early.x > 0.28 && early.x < 0.72, `early frame drifted to ${early.x}`);
  assert.ok(late.x > 0.28 && late.x < 0.72, `late frame drifted to ${late.x}`);
  const spoken = await captionInk(output, 0.6, root);
  const silent = await captionInk(output, 2.6, root);
  assert.ok(spoken > 1500, `caption ink too faint: ${spoken}`);
  assert.ok(spoken > silent * 4, "burned caption did not change the picture");
  fs.rmSync(root, { recursive: true, force: true });
});

test("spoken audio becomes timed words", { timeout: 180_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "keel-speech-"));
  const wav = path.join(root, "speech.wav");
  const spoken = "This is a spoken caption test for the cutting room.";
  await new Promise<void>((resolve, reject) => {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $s.Speak('${spoken}'); $s.Dispose()`;
    import("node:child_process").then(({ execFile }) => {
      execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
  });
  const transcript = await transcribeFile(wav);
  assert.ok(transcript.words.length >= 4, `expected words, got ${transcript.text}`);
  const heard = transcript.text.toLowerCase();
  assert.ok(heard.includes("caption") || heard.includes("spoken") || heard.includes("cutting"), heard);
  assert.ok(transcript.words.every((word, index) => index === 0 || word.start >= transcript.words[index - 1].start - 0.05));
  fs.rmSync(root, { recursive: true, force: true });
});

async function brightCenter(
  exec: (file: string, args: string[]) => Promise<unknown>,
  video: string,
  time: number,
  root: string,
): Promise<{ x: number; count: number }> {
  const png = path.join(root, `f-${time}.png`);
  await exec("ffmpeg", ["-y", "-ss", String(time), "-i", video, "-frames:v", "1", png]);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("python", ["-c", "import cv2,sys; img=cv2.imread(sys.argv[1],0); ys,xs=(img>180).nonzero(); print(0 if len(xs)==0 else xs.mean()/img.shape[1]); print(len(xs))", png]);
  const [x, count] = stdout.trim().split(/\s+/).map(Number);
  return { x, count };
}

async function captionInk(video: string, time: number, root: string): Promise<number> {
  const png = path.join(root, `l-${time}.png`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  await exec("ffmpeg", ["-y", "-ss", String(time), "-i", video, "-frames:v", "1", png]);
  const { stdout } = await exec("python", ["-c", "import cv2,sys; img=cv2.imread(sys.argv[1]); h=img.shape[0]; band=img[int(h*0.70):int(h*0.96)]; print(int((band.max(axis=2)>40).sum()))", png]);
  return Number(stdout.trim());
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the cut flow.");
}
