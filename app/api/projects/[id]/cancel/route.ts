import { fail, json } from "@/lib/http";
import { claimed, requestCancel } from "@/lib/jobs";
import { projectView, releaseStuck } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const view = projectView(id);
  if (!view) return fail(new Error("That source is gone."), 404);
  if (claimed(id)) {
    requestCancel(id);
    return json({ ok: true }, 202);
  }
  if (view.project.status !== "analyzing" && !view.clips.some((clip) => clip.status === "exporting")) {
    return fail(new Error("Nothing is running."));
  }
  if (!releaseStuck(id)) return fail(new Error("That job is still running."), 409);
  return json({ ok: true }, 202);
}
