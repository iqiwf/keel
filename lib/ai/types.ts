import type { HighlightDraft, Transcript } from "../types";

export interface AnalyzeInput {
  title: string;
  duration: number;
  targetSeconds: number;
  audioPath?: string;
}

export interface AiProvider {
  readonly name: string;
  transcribe(input: AnalyzeInput): Promise<Transcript>;
  findHighlights(input: AnalyzeInput, transcript: Transcript): Promise<HighlightDraft[]>;
}
