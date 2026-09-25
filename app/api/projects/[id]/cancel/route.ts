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
  if (view.project.status !== "analyzing" && !claimed(id)) return fail(new Error("Nothing is running."));
  requestCancel(id);
  if (!claimed(id)) releaseStuck(id);
  return json({ ok: true }, 202);
}
