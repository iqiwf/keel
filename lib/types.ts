export const ASPECTS = ["9:16", "1:1", "16:9"] as const;
export type Aspect = (typeof ASPECTS)[number];

export const CAPTION_STYLES = ["ledger", "ticker", "quiet"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const PROJECT_STATUSES = [
  "draft",
  "analyzing",
  "ready",
  "failed",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const CLIP_STATUSES = ["ready", "exporting", "exported", "failed"] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language: string;
  text: string;
  words: TranscriptWord[];
}

export interface Project {
  id: string;
  title: string;
  source: "upload" | "url";
  sourceLabel: string;
  fileName: string;
  duration: number;
  status: ProjectStatus;
  error: string | null;
  progress: number;
  stage: string;
  createdAt: string;
  transcript: Transcript | null;
}

export interface Clip {
  id: string;
  projectId: string;
  title: string;
  hook: string;
  reason: string;
  score: number;
  start: number;
  end: number;
  aspect: Aspect;
  captionStyle: CaptionStyle;
  captionText: string;
  status: ClipStatus;
  exportName: string | null;
  error: string | null;
  createdAt: string;
}

export interface StoreData {
  projects: Project[];
  clips: Clip[];
}

export interface HighlightDraft {
  title: string;
  hook: string;
  reason: string;
  score: number;
  start: number;
  end: number;
  captionText: string;
}
