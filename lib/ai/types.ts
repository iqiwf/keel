import type { HighlightDraft, Transcript } from "../types";

export interface AnalyzeInput {
  title: string;
  duration: number;
  targetSeconds: number;
  audioPath?: string;
  windows?: { start: number; end: number }[];
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly name: string;
  transcribe(input: AnalyzeInput): Promise<Transcript>;
  findHighlights(input: AnalyzeInput, transcript: Transcript): Promise<HighlightDraft[]>;
}
