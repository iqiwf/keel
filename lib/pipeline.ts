import fs from "node:fs";
import path from "node:path";
import { getProvider } from "./ai";
import { dataDir } from "./config";
import { id } from "./ids";
import { clipsFor, getClip, getProject, masterPath, replaceClips, saveClip, updateProject } from "./store";
import { cuesFromWords } from "./captions";
import type { Clip } from "./types";
import { extractAudio, probeDuration, renderClip, scanEnergy } from "./video/ffmpeg";
import { planCrop } from "./video/reframe";
import { detectTrack, readTrack, saveTrack } from "./video/subjects";
import { parseEnergy, selectWindows } from "./video/windows";
import { downloadYoutube } from "./video/youtube";

export async function ingestUpload(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project) return;
  try {
    const duration = await probeDuration(masterPath(project));
    updateProject(projectId, { duration, status: "draft", stage: "Ready to mark", progress: 100, error: null });
  } catch (error) { fail(projectId, error); }
}

export async function ingestUrl(projectId: string, pageUrl: string): Promise<void> {
  const project = getProject(projectId);
  if (!project) return;
  try {
    updateProject(projectId, { stage: "Fetching the source", progress: 15, status: "analyzing" });
    const file = path.join(path.dirname(masterPath(project)), project.fileName);
    const title = await downloadYoutube(pageUrl, file);
    const duration = await probeDuration(file);
    updateProject(projectId, { title: title || project.title, duration, status: "draft", stage: "Ready to mark", progress: 100, error: null });
  } catch (error) { fail(projectId, error); }
}

export async function analyzeProject(projectId: string, targetSeconds: number): Promise<void> {
  const project = getProject(projectId);
  if (!project || project.duration < 3) return;
  if (project.status === "analyzing" && project.stage.startsWith("Reading")) return;
  const audioPath = path.join(dataDir(), "tmp", `${projectId}.mp3`);
  try {
    updateProject(projectId, { status: "analyzing", stage: "Scanning the soundtrack", progress: 12, error: null, warning: null });
    const provider = getProvider();
    const source = masterPath(project);
    const long = provider.name === "local" && project.duration >= 8 * 60;
    const windows = long ? selectWindows(parseEnergy(await scanEnergy(source)), project.duration, targetSeconds) : undefined;
    updateProject(projectId, { stage: "Reading the soundtrack", progress: 28 });
    if (provider.name === "openai") {
      fs.mkdirSync(path.dirname(audioPath), { recursive: true });
      await extractAudio(source, audioPath);
    }
    const transcript = await provider.transcribe({
      title: project.title,
      duration: project.duration,
      targetSeconds,
      audioPath: provider.name === "openai" ? audioPath : provider.name === "local" ? source : undefined,
      windows,
    });
    if (!transcript.words.length && provider.name !== "mock") {
      updateProject(projectId, { warning: "No speech was detected, so these cuts have no captions. You can type a line before printing." });
    }
    updateProject(projectId, { transcript, stage: "Finding the speaker", progress: 58 });
    let trackWarning: string | null = null;
    try {
      const cached = readTrack(projectId);
      const same = !windows || covers(cached?.coverage, windows);
      if (!cached || !same) saveTrack(projectId, await detectTrack(source, windows));
    } catch (error) {
      trackWarning = error instanceof Error ? error.message : "Speaker tracking failed.";
      console.error("speaker tracking failed", trackWarning);
    }
    updateProject(projectId, { stage: "Choosing the cuts", progress: 78 });
    for (const previous of clipsFor(projectId)) {
      if (previous.exportName) fs.rmSync(path.join(dataDir(), "exports", previous.exportName), { force: true });
    }
    const drafts = await provider.findHighlights({ title: project.title, duration: project.duration, targetSeconds, audioPath }, transcript);
    const now = new Date().toISOString();
    const clips: Clip[] = drafts.map((draft, index) => {
      const start = Math.max(0, Math.min(project.duration - 3, draft.start));
      const end = Math.min(project.duration, Math.max(start + 3, draft.end));
      const cues = cuesFromWords(transcript.words, start, end);
      return {
        id: id("clp"), projectId, title: draft.title, hook: draft.hook, reason: draft.reason, score: draft.score,
        start, end,
        aspect: index % 3 === 1 ? "1:1" : index % 3 === 2 ? "16:9" : "9:16",
        captionStyle: index % 2 === 0 ? "ledger" : "ticker",
        captionText: cues.map((cue) => cue.text).join(" ") || draft.captionText,
        cues, status: "ready", exportName: null,
        error: cues.length ? null : provider.name === "mock" ? null : "No speech in this cut.",
        createdAt: now,
      };
    });
    replaceClips(projectId, clips);
    const current = getProject(projectId);
    const warning = [current?.warning, trackWarning ? `Speaker tracking failed, so the frame stays centered. ${trackWarning}` : null].filter(Boolean).join(" ");
    updateProject(projectId, { status: "ready", stage: clips.some((clip) => clip.cues.length) ? "Cuts are on the bench" : "Cuts are ready, without captions", progress: 100, warning: warning || null });
  } catch (error) {
    fail(projectId, error);
  } finally {
    fs.rmSync(audioPath, { force: true });
  }
}

export async function exportClip(clipId: string): Promise<void> {
  const clip = getClip(clipId);
  if (!clip) return;
  const project = getProject(clip.projectId);
  if (!project) return;
  const outputName = `${clip.id}.mp4`;
  const output = path.join(dataDir(), "exports", outputName);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const printing = getClip(clipId);
  if (!printing) return;
  saveClip({ ...printing, status: "exporting", error: null });
  try {
    const latest = getClip(clipId) ?? printing;
    const track = readTrack(project.id);
    await renderClip({
      source: masterPath(project), output, start: latest.start, end: latest.end,
      aspect: latest.aspect, style: latest.captionStyle, cues: latest.cues ?? [],
      caption: latest.cues?.length ? "" : latest.captionText,
      crop: track ? planCrop(track, latest.aspect, latest.start, latest.end) : null,
    });
    const current = getClip(clipId);
    if (!current) return;
    const unchanged = current.start === latest.start && current.end === latest.end && current.aspect === latest.aspect && current.captionText === latest.captionText;
    if (!unchanged) fs.rmSync(output, { force: true });
    saveClip({
      ...current,
      status: unchanged ? "exported" : "ready",
      exportName: unchanged ? outputName : null,
      error: unchanged ? null : "The cut changed while printing. Print it again.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed.";
    console.error("export failed", message);
    fs.rmSync(output, { force: true });
    const latest = getClip(clipId);
    if (latest) saveClip({ ...latest, status: "failed", exportName: null, error: message });
  }
}

export function projectView(projectId: string) {
  const project = getProject(projectId);
  if (!project) return null;
  return { project, clips: clipsFor(projectId), frame: readTrack(projectId) };
}

function covers(saved: { start: number; end: number }[] | undefined, wanted: { start: number; end: number }[]): boolean {
  if (!saved || saved.length !== wanted.length) return false;
  return wanted.every((window, index) => Math.abs(saved[index].start - window.start) < 0.2 && Math.abs(saved[index].end - window.end) < 0.2);
}

function fail(projectId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  console.error("analyze failed", message);
  updateProject(projectId, { status: "failed", error: message, stage: "Stopped", progress: 100 });
}
