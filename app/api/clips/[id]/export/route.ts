import { fail, json } from "@/lib/http";
import { atCapacity, claimed, sourceBusy } from "@/lib/jobs";
import { beginExport } from "@/lib/pipeline";
import { getClip, getProject } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const clip = getClip(id);
  if (!clip) return fail(new Error("That cut is gone."), 404);
  const project = getProject(clip.projectId);
  if (!project) return fail(new Error("That source is gone."), 404);
  if (sourceBusy(claimed(project.id))) {
    return fail(new Error("This source is already busy."), 409);
  }
  if (atCapacity()) return fail(new Error("Keel is already working on other sources. Try again in a moment."), 429);
  if (!beginExport(id)) return fail(new Error("This source is already busy."), 409);
  return json({ ok: true }, 202);
}
