import path from "node:path";

export function dataDir(): string {
  return process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(process.cwd(), ".data");
}

export function maxUploadBytes(): number {
  const mb = Number(process.env.MAX_UPLOAD_MB ?? "300");
  if (!Number.isFinite(mb) || mb < 1 || mb > 2048) return 300 * 1024 * 1024;
  return Math.floor(mb) * 1024 * 1024;
}

export function aiProviderName(): "mock" | "openai" {
  return process.env.AI_PROVIDER === "openai" ? "openai" : "mock";
}
