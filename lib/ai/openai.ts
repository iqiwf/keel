import fs from "node:fs";
import { sanitizeDrafts } from "../highlights";
import type { HighlightDraft, Transcript } from "../types";
import type { AiProvider, AnalyzeInput } from "./types";

function baseUrl(): string {
  const raw = process.env.OPENAI_BASE_URL || "https://api.openai.com";
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("OPENAI_BASE_URL must use https.");
  return url.origin;
}

function key(): string {
  const value = process.env.OPENAI_API_KEY;
  if (!value) throw new Error("OPENAI_API_KEY is not set.");
  return value;
}

async function openAi(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key()}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`The model request failed (${response.status}). ${detail}`);
  }
  return response;
}

export const openAiProvider: AiProvider = {
  name: "openai",
  async transcribe(input) {
    if (!input.audioPath) throw new Error("Transcription needs an audio file.");
    const body = new FormData();
    const bytes = fs.readFileSync(input.audioPath);
    body.append("file", new Blob([bytes], { type: "audio/mpeg" }), "speech.mp3");
    body.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1");
    body.append("response_format", "verbose_json");
    body.append("timestamp_granularities[]", "word");
    const response = await openAi("/v1/audio/transcriptions", { method: "POST", body });
    const json = (await response.json()) as {
      text?: string;
      language?: string;
      words?: { word?: string; start?: number; end?: number }[];
    };
    const words = (json.words ?? [])
      .filter((word) => word.word && typeof word.start === "number")
      .map((word) => ({
        text: String(word.word).trim(),
        start: Number(word.start),
        end: Number(word.end ?? word.start),
      }));
    return {
      language: json.language || "en",
      text: json.text || words.map((word) => word.text).join(" "),
      words,
    };
  },
  async findHighlights(input, transcript) {
    const response = await openAi("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_HIGHLIGHT_MODEL || "gpt-4o-mini",
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You select short-form clips. Return JSON {clips:[{title,hook,reason,score,start,end,captionText}]}. Times are seconds. Stay inside the source duration. Do not invent quotes that are not in the transcript.",
          },
          {
            role: "user",
            content: JSON.stringify({
              duration: input.duration,
              targetSeconds: input.targetSeconds,
              transcript: transcript.text.slice(0, 12000),
              words: transcript.words.slice(0, 800),
            }),
          },
        ],
      }),
    });
    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content) as { clips?: HighlightDraft[] };
    const clips = sanitizeDrafts(Array.isArray(parsed.clips) ? parsed.clips : [], input.duration);
    if (!clips.length) throw new Error("The model did not return any clips.");
    return clips;
  },
};
