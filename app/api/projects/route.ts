import path from "node:path";
import { maxUploadBytes } from "@/lib/config";
import { id } from "@/lib/ids";
import { json, fail } from "@/lib/http";
import { ingestUpload, ingestUrl } from "@/lib/pipeline";
import { listProjects, mastersDir, saveProject, updateProject, writeBounded } from "@/lib/store";
import type { Project } from "@/lib/types";
import { assertVideoFile, parseVideoUrl, safeBaseName } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return json({
    projects: listProjects().map((project) => ({
      ...project,
      transcript: undefined,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const type = request.headers.get("content-type") || "";
    if (type.includes("application/json")) return fromUrl(await request.json());
    if (type.includes("multipart/form-data")) return fromUpload(await request.formData());
    return json({ error: "Send a video file or a YouTube link." }, 415);
  } catch (error) {
    return fail(error);
  }
}

async function fromUrl(body: unknown): Promise<Response> {
  const url = parseVideoUrl(String((body as { url?: string })?.url ?? ""));
  const project = createProject("url", url.toString(), ".mp4", "Fetching the source");
  void ingestUrl(project.id, url.toString());
  return json({ project }, 202);
}

async function fromUpload(form: FormData): Promise<Response> {
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("Choose a video file.");
  const ext = assertVideoFile(file.name, file.type, file.size, maxUploadBytes());
  const project = createProject("upload", safeBaseName(file.name), ext, "Reading the file");
  const target = path.join(mastersDir(), project.fileName);
  try {
    await writeBounded(file, target, maxUploadBytes());
  } catch (error) {
    const message = error instanceof Error ? error.message : "The file was refused.";
    updateProject(project.id, { status: "failed", error: message, stage: "Stopped", progress: 100 });
    throw error;
  }
  void ingestUpload(project.id);
  return json({ project }, 202);
}

function createProject(source: Project["source"], label: string, ext: string, stage: string): Project {
  const projectId = id("prj");
  const project: Project = {
    id: projectId,
    title: source === "url" ? "Incoming source" : label.replace(/\.[a-z0-9]+$/i, ""),
    source,
    sourceLabel: label,
    fileName: `${projectId}${ext}`,
    duration: 0,
    status: "analyzing",
    error: null,
    progress: 8,
    stage,
    createdAt: new Date().toISOString(),
    transcript: null,
    warning: null,
  };
  return saveProject(project);
}
