import fs from "node:fs";
import path from "node:path";
import { getProvider } from "./ai";
import { dataDir, whisperModel } from "./config";
import { id } from "./ids";
import { claim, release } from "./jobs";
import { clipsFor, getClip, getProject, masterPath, replaceClips, saveClip, updateProject } from "./store";
import { cuesFromWords } from "./captions";
import type { Clip, Cue, Transcript } from "./types";
import { extractAudio, probeDuration, renderClip, scanEnergy } from "./video/ffmpeg";
import { planCrop } from "./video/reframe";
import { alignWords, readTranscript, saveTranscript, transcriptMatches } from "./video/speech";
import { detectTrack, readTrack, saveTrack, sourceFingerprint, trackMatches } from "./video/subjects";
import { selectWindows, type TimeWindow } from "./video/windows";
import { downloadYoutube } from "./video/youtube";

export function beginAnalyze(projectId: string, targetSeconds: number): boolean {
  if (!claim(projectId)) return false;
  void analyzeProject(projectId, targetSeconds).finally(() => release(projectId));
  return true;
}

export function beginExport(clipId: string): boolean {
  const clip = getClip(clipId);
  if (!clip || !claim(clip.projectId)) return false;
  void exportClip(clipId).finally(() => release(clip.projectId));
  return true;
}

export function cutsMatch(
  left: { start: number; end: number; aspect: string; captionStyle: string; captionText: string; cues?: Cue[] },
  right: { start: number; end: number; aspect: string; captionStyle: string; captionText: string; cues?: Cue[] },
): boolean {
  const a = left.cues ?? [];
  const b = right.cues ?? [];
  if (a.length !== b.length) return false;
  const cues = a.every((cue, index) => cue.start === b[index].start && cue.end === b[index].end && cue.text === b[index].text);
  return left.start === right.start
    && left.end === right.end
    && left.aspect === right.aspect
    && left.captionStyle === right.captionStyle
    && left.captionText === right.captionText
    && cues;
}

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
  const audioPath = path.join(dataDir(), "tmp", `${projectId}.mp3`);
  try {
    updateProject(projectId, { status: "analyzing", stage: "Scanning the soundtrack", progress: 12, error: null, warning: null });
    const provider = getProvider();
    const source = masterPath(project);
    const fingerprint = sourceFingerprint(source);
    const long = provider.name === "local" && project.duration >= 8 * 60;
    const windows = long ? selectWindows(await scanEnergy(source), project.duration, targetSeconds) : undefined;
    updateProject(projectId, { stage: "Reading the soundtrack", progress: 28 });
    const transcript = await transcriptFor(projectId, provider.name, source, audioPath, fingerprint, windows, {
      title: project.title,
      duration: project.duration,
      targetSeconds,
    });
    if (!transcript.words.length && provider.name !== "mock") {
      updateProject(projectId, { warning: "No speech was detected, so these cuts have no captions. You can type a line before printing." });
    }
    updateProject(projectId, { transcript, stage: "Finding the speaker", progress: 58 });
    let trackWarning: string | null = null;
    try {
      if (!trackMatches(readTrack(projectId), fingerprint, windows)) {
        saveTrack(projectId, { ...await detectTrack(source, windows), fingerprint });
      }
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

async function transcriptFor(
  projectId: string,
  providerName: string,
  source: string,
  audioPath: string,
  fingerprint: string,
  windows: TimeWindow[] | undefined,
  input: { title: string; duration: number; targetSeconds: number },
): Promise<Transcript> {
  const provider = getProvider();
  const model = providerName === "openai"
    ? `openai:${process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1"}`
    : providerName === "local"
      ? `local:${whisperModel()}`
      : providerName;
  const cached = readTranscript(projectId);
  if (providerName !== "mock" && transcriptMatches(cached, fingerprint, model, windows)) return cached!.transcript;
  if (providerName === "openai") {
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    await extractAudio(source, audioPath);
  }
  const transcript = await provider.transcribe({
    ...input,
    audioPath: providerName === "openai" ? audioPath : providerName === "local" ? source : undefined,
    windows,
  });
  const aligned = { ...transcript, words: alignWords(transcript.words, windows) };
  if (providerName !== "mock") {
    saveTranscript(projectId, { fingerprint, model, windows: windows ?? [], transcript: aligned });
  }
  return aligned;
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
    const source = masterPath(project);
    const fresh = track?.fingerprint && fs.existsSync(source) && track.fingerprint === sourceFingerprint(source) ? track : null;
    await renderClip({
      source, output, start: latest.start, end: latest.end,
      aspect: latest.aspect, style: latest.captionStyle, cues: latest.cues ?? [],
      caption: latest.cues?.length ? "" : latest.captionText,
      crop: fresh ? planCrop(fresh, latest.aspect, latest.start, latest.end) : null,
    });
    const current = getClip(clipId);
    if (!current) return;
    const unchanged = cutsMatch(current, latest);
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
  const frame = readTrack(projectId);
  const file = masterPath(project);
  const live = fs.existsSync(file) ? sourceFingerprint(file) : "";
  return { project, clips: clipsFor(projectId), frame: frame?.fingerprint === live ? frame : null };
}

function fail(projectId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  console.error("analyze failed", message);
  updateProject(projectId, { status: "failed", error: message, stage: "Stopped", progress: 100 });
}
