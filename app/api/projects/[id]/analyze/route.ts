import { fail, json } from "@/lib/http";
import { analyzeProject, projectView } from "@/lib/pipeline";
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
    if (view.project.duration <= 0 || view.project.status === "analyzing") {
      return fail(new Error("Wait until the source has finished loading."));
    }
    const body = (await request.json()) as { targetSeconds?: number };
    const target = durationSchema.parse(body.targetSeconds);
    void analyzeProject(id, target);
    return json({ ok: true }, 202);
  } catch (error) {
    return fail(error);
  }
}
