import { z } from "zod";
import { ASPECTS, CAPTION_STYLES } from "./types";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".m4v",
]);

const VIDEO_MIME = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "application/octet-stream",
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function assertVideoFile(name: string, type: string, size: number, max: number): string {
  const ext = extensionOf(name);
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw new Error("Use an MP4, MOV, WebM, or MKV file.");
  }
  if (type && !VIDEO_MIME.has(type)) {
    throw new Error("That file does not look like a video.");
  }
  if (size <= 0) throw new Error("The file is empty.");
  if (size > max) {
    throw new Error(`Files must be under ${Math.round(max / (1024 * 1024))} MB.`);
  }
  return ext;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export function parseVideoUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a full YouTube link, including https://.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https links are accepted.");
  }
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new Error("Only YouTube links are accepted in this version.");
  }
  if (host === "youtu.be" || host === "www.youtu.be") {
    if (!/^\/[\w-]{6,}$/.test(url.pathname)) {
      throw new Error("That short YouTube link is incomplete.");
    }
    return url;
  }
  const id = url.searchParams.get("v");
  const shorts = url.pathname.match(/^\/shorts\/([\w-]{6,})/);
  const embed = url.pathname.match(/^\/embed\/([\w-]{6,})/);
  const live = url.pathname.match(/^\/live\/([\w-]{6,})/);
  if ((!id || id.length < 6) && !shorts && !embed && !live) {
    throw new Error("That YouTube link has no video id.");
  }
  return url;
}

export const durationSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(45),
  z.literal(60),
]);

export const clipPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    start: z.number().min(0).max(60 * 60 * 6).optional(),
    end: z.number().min(0.5).max(60 * 60 * 6).optional(),
    aspect: z.enum(ASPECTS).optional(),
    captionStyle: z.enum(CAPTION_STYLES).optional(),
    captionText: z.string().max(500).optional(),
    cues: z.array(z.object({
      start: z.number().min(0).max(60 * 60 * 6),
      end: z.number().min(0).max(60 * 60 * 6),
      text: z.string().max(160),
    })).max(80).optional(),
  })
  .strict();

export function safeBaseName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "video";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "video").slice(0, 80);
}
