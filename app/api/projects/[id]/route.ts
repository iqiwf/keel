import { fail, json } from "@/lib/http";
import { projectView } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const view = projectView(id);
  if (!view) return fail(new Error("That source is gone."), 404);
  return json(view);
}
