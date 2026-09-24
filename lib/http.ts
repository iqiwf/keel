import { ZodError } from "zod";

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function fail(error: unknown, status = 400): Response {
  if (error instanceof ZodError) {
    return json({ error: "Check those fields and try again." }, 400);
  }
  const message = error instanceof Error ? error.message : "Request failed.";
  return json({ error: message }, status);
}
