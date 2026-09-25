import { fail, json } from "@/lib/http";
import { beginAnalyze, projectView } from "@/lib/pipeline";
import { durationSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const view = projectView(id);
    if (!view) return fail(new Error("That source is gone."), 404);
    if (view.project.duration < 3 || view.project.status === "analyzing") {
      return fail(new Error("The source must be at least 3 seconds and fully loaded before marking cuts."));
    }
    if (view.clips.some((clip) => clip.status === "exporting")) {
      return fail(new Error("Wait for the print to finish before marking again."), 409);
    }
    const body = (await request.json()) as { targetSeconds?: number };
    const target = durationSchema.parse(body.targetSeconds);
    if (!beginAnalyze(id, target)) return fail(new Error("This source is already busy."), 409);
    return json({ ok: true }, 202);
  } catch (error) {
    return fail(error);
  }
}