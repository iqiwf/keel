import { fail, json } from "@/lib/http";
import { getClip, getProject, saveClip } from "@/lib/store";
import { clipPatchSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const clip = getClip(id);
    if (!clip) return fail(new Error("That cut is gone."), 404);
    const project = getProject(clip.projectId);
    if (!project) return fail(new Error("That source is gone."), 404);
    const patch = clipPatchSchema.parse(await request.json());
    const start = patch.start ?? clip.start;
    const end = patch.end ?? clip.end;
    if (end <= start) return fail(new Error("The out point has to land after the in point."));
    if (end - start < 3) return fail(new Error("A cut needs at least 3 seconds."));
    if (end - start > 90) return fail(new Error("Keep a cut under 90 seconds."));
    if (end > project.duration + 0.05) return fail(new Error("That out point is past the end of the source."));
    const cues = patch.cues?.map((cue) => ({
      ...cue,
      start: Math.max(start, Math.min(end, cue.start)),
      end: Math.max(start, Math.min(end, cue.end)),
    })).filter((cue) => cue.end > cue.start && cue.text.trim()) ?? clip.cues;
    const next = saveClip({
      ...clip,
      ...patch,
      start,
      end: Math.min(end, project.duration),
      cues,
      captionText: patch.cues ? cues.map((cue) => cue.text).join(" ") : (patch.captionText ?? clip.captionText),
      status: clip.exportName ? "ready" : clip.status === "failed" ? "ready" : clip.status,
      exportName: null,
      error: null,
    });
    return json({ clip: next });
  } catch (error) {
    return fail(error);
  }
}