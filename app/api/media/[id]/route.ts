import fs from "node:fs";
import { Readable } from "node:stream";
import { fail } from "@/lib/http";
import { exportsDir, getClip, getProject, masterPath } from "@/lib/store";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^(?:prj|clp)_[a-f0-9]{16}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!ID.test(id)) return fail(new Error("Unknown media."), 404);
  const file = resolve(id);
  if (!file || !fs.existsSync(file)) return fail(new Error("Media is not ready."), 404);
  return streamFile(request, file);
}

function resolve(id: string): string | null {
  if (id.startsWith("prj_")) {
    const project = getProject(id);
    if (!project || project.fileName !== `${id}${extension(project.fileName)}`) return null;
    const file = masterPath(project);
    return isInside(file, path.dirname(file)) ? file : null;
  }
  const clip = getClip(id);
  if (!clip?.exportName || clip.exportName !== `${id}.mp4`) return null;
  const file = path.join(exportsDir(), clip.exportName);
  return isInside(file, exportsDir()) ? file : null;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function isInside(file: string, root: string): boolean {
  const resolved = path.resolve(file);
  const base = path.resolve(root);
  return resolved.startsWith(base + path.sep);
}

function mediaType(file: string): string {
  if (file.endsWith(".webm")) return "video/webm";
  if (file.endsWith(".mov")) return "video/quicktime";
  if (file.endsWith(".mkv")) return "video/x-matroska";
  return "video/mp4";
}

function streamFile(request: Request, file: string): Response {
  const stat = fs.statSync(file);
  const range = request.headers.get("range");
  const common = {
    "Content-Type": mediaType(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
  };
  if (!range) {
    const node = fs.createReadStream(file);
    return new Response(Readable.toWeb(node) as ReadableStream, {
      headers: { ...common, "Content-Length": String(stat.size) },
    });
  }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) return new Response(null, { status: 416 });
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start > end || end >= stat.size) return new Response(null, { status: 416 });
  const node = fs.createReadStream(file, { start, end });
  return new Response(Readable.toWeb(node) as ReadableStream, {
    status: 206,
    headers: {
      ...common,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}
