import { highlightsFromSpeech } from "../highlights";
import type { AiProvider } from "./types";

export const localProvider: AiProvider = {
  name: "local",
  async transcribe(input) {
    if (!input.audioPath) throw new Error("Transcription needs an audio file.");
    const { transcribeFile } = await import("../video/speech");
    return transcribeFile(input.audioPath);
  },
  async findHighlights(input, transcript) {
    const clips = highlightsFromSpeech(input.duration, input.targetSeconds, transcript);
    if (!clips.length) throw new Error("No cuts could be marked.");
    return clips;
  },
};
