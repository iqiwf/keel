import { fail, json } from "@/lib/http";
import { exportClip } from "@/lib/pipeline";
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
  if (clip.status === "exporting") return fail(new Error("This cut is already printing."));
  void exportClip(id);
  return json({ ok: true }, 202);
}
