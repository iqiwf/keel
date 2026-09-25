import { fail, json } from "@/lib/http";
import { requestCancel } from "@/lib/jobs";
import { projectView } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const view = projectView(id);
  if (!view) return fail(new Error("That source is gone."), 404);
  if (view.project.status !== "analyzing") return fail(new Error("Nothing is running."));
  requestCancel(id);
  return json({ ok: true }, 202);
}
