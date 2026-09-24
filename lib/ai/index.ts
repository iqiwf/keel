import { aiProviderName } from "../config";
import { mockProvider } from "./mock";
import { openAiProvider } from "./openai";
import type { AiProvider } from "./types";

export function getProvider(): AiProvider {
  return aiProviderName() === "openai" ? openAiProvider : mockProvider;
}

export type { AiProvider, AnalyzeInput } from "./types";
