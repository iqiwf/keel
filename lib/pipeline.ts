import fs from "node:fs";
import path from "node:path";
import { getProvider } from "./ai";
import { dataDir } from "./config";
import { id } from "./ids";
import {
  clipsFor,
  getClip,
  getProject,
  masterPath,
  replaceClips,
  saveClip,
  updateProject,
} from "./store";
import type { Clip } from "./types";
import { extractAudio, probeDuration, renderClip } from "./video/ffmpeg";
import { downloadYoutube } from "./video/youtube";

export async function ingestUpload(projectId: string): Promise<void> {
  const project = getProject(projectId);
  if (!project) return;
  try {
    const duration = await probeDuration(masterPath(project));
    updateProject(projectId, {
      duration,
      status: "draft",
      stage: "Ready to mark",
      progress: 100,
      error: null,
    });
  } catch (error) {
    fail(projectId, error);
  }
}

export async function ingestUrl(projectId: string, pageUrl: string): Promise<void> {
  const project = getProject(projectId);
  if (!project) return;
  try {
    updateProject(projectId, { stage: "Fetching the source", progress: 15, status: "analyzing" });
    const file = path.join(path.dirname(masterPath(project)), project.fileName);
    const title = await downloadYoutube(pageUrl, file);
    const duration = await probeDuration(file);
    updateProject(projectId, {
      title: title || project.title,
      duration,
      status: "draft",
      stage: "Ready to mark",
      progress: 100,
      error: null,
    });
  } catch (error) {
    fail(projectId, error);
  }
}

export async function analyzeProject(projectId: string, targetSeconds: number): Promise<void> {
  const project = getProject(projectId);
  if (!project) return;
  if (project.status === "analyzing" && project.stage.startsWith("Reading")) return;
  try {
    updateProject(projectId, { status: "analyzing", stage: "Reading the soundtrack", progress: 28, error: null });
    const provider = getProvider();
    let audioPath: string | undefined;
    if (provider.name === "openai") {
      audioPath = path.join(dataDir(), "tmp", `${projectId}.mp3`);
      fs.mkdirSync(path.dirname(audioPath), { recursive: true });
      await extractAudio(masterPath(project), audioPath);
    }
    const transcript = await provider.transcribe({
      title: project.title,
      duration: project.duration,
      targetSeconds,
      audioPath,
    });
    updateProject(projectId, { transcript, stage: "Choosing the cuts", progress: 68 });
    for (const previous of clipsFor(projectId)) {
      if (!previous.exportName) continue;
      fs.rmSync(path.join(dataDir(), "exports", previous.exportName), { force: true });
    }
    const drafts = await provider.findHighlights(
      { title: project.title, duration: project.duration, targetSeconds, audioPath },
      transcript,
    );
    const now = new Date().toISOString();
    const clips: Clip[] = drafts.map((draft, index) => ({
      id: id("clp"),
      projectId,
      title: draft.title,
      hook: draft.hook,
      reason: draft.reason,
      score: draft.score,
      start: draft.start,
      end: Math.min(project.duration, Math.max(draft.start + 3, draft.end)),
      aspect: index % 3 === 1 ? "1:1" : index % 3 === 2 ? "16:9" : "9:16",
      captionStyle: index % 2 === 0 ? "ledger" : "ticker",
      captionText: draft.captionText,
      status: "ready",
      exportName: null,
      error: null,
      createdAt: now,
    }));
    replaceClips(projectId, clips);
    if (audioPath) fs.rmSync(audioPath, { force: true });
    updateProject(projectId, { status: "ready", stage: "Cuts are on the bench", progress: 100 });
  } catch (error) {
    fail(projectId, error);
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
  saveClip({ ...clip, status: "exporting", error: null });
  try {
    const latest = getClip(clipId) ?? clip;
    await renderClip({
      source: masterPath(project),
      output,
      start: latest.start,
      end: latest.end,
      aspect: latest.aspect,
      caption: latest.captionText,
      style: latest.captionStyle,
    });
    saveClip({ ...latest, status: "exported", exportName: outputName, error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed.";
    const latest = getClip(clipId);
    if (latest) saveClip({ ...latest, status: "failed", error: message });
  }
}

export function projectView(projectId: string) {
  const project = getProject(projectId);
  if (!project) return null;
  return { project, clips: clipsFor(projectId) };
}

function fail(projectId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  updateProject(projectId, { status: "failed", error: message, stage: "Stopped", progress: 100 });
}
