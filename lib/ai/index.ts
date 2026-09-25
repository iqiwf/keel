import { aiProviderName } from "../config";
import { localProvider } from "./local";
import { mockProvider } from "./mock";
import { openAiProvider } from "./openai";
import type { AiProvider } from "./types";

export function getProvider(): AiProvider {
  const name = aiProviderName();
  if (name === "openai") return openAiProvider;
  if (name === "mock") return mockProvider;
  return localProvider;
}

export type { AiProvider, AnalyzeInput } from "./types";
