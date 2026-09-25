"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Aspect, CaptionStyle, Clip, Cue, Project } from "@/lib/types";
import { planCrop, previewBox, type SubjectTrack } from "@/lib/video/reframe";

type View = { project: Project; clips: Clip[]; frame?: SubjectTrack | null };

const LENGTHS = [15, 30, 45, 60] as const;
const ASPECTS: Aspect[] = ["9:16", "1:1", "16:9"];
const STYLES: { id: CaptionStyle; label: string }[] = [
  { id: "ledger", label: "Ledger" },
  { id: "ticker", label: "Ticker" },
  { id: "quiet", label: "Quiet" },
];

function clock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
}

export function Studio() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState<(typeof LENGTHS)[number]>(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const clip = view?.clips.find((item) => item.id === activeId) ?? view?.clips[0] ?? null;

  const refreshList = useCallback(async () => {
    const response = await fetch("/api/projects");
    const body = (await response.json()) as { projects?: Project[]; error?: string };
    if (body.projects) setProjects(body.projects);
  }, []);

  const load = useCallback(async (id: string) => {
    const response = await fetch(`/api/projects/${id}`);
    const body = (await response.json()) as View & { error?: string };
    if (!response.ok) {
      setError(body.error ?? "Could not open that source.");
      return;
    }
    setView(body);
    setActiveId((current) => current && body.clips.some((item) => item.id === current)
      ? current
      : body.clips[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void refreshList().catch(() => setError("The bench could not load."));
  }, [refreshList]);

  useEffect(() => {
    if (!view) return;
    const working = view.project.status === "analyzing" || view.clips.some((item) => item.status === "exporting");
    if (!working) return;
    const timer = window.setInterval(() => {
      void load(view.project.id);
      void refreshList();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [view, load, refreshList]);

  useEffect(() => {
    if (!clip) return;
    const at = clip.exportName ? 0 : clip.start;
    setPlayhead(at);
    const node = videoRef.current;
    if (!node || clip.exportName || view?.project.status !== "ready") return;
    const seek = () => {
      if (Math.abs(node.currentTime - clip.start) > 0.05) node.currentTime = clip.start;
    };
    if (node.readyState >= 1) seek();
    else node.addEventListener("loadedmetadata", seek);
    return () => node.removeEventListener("loadedmetadata", seek);
  }, [clip?.id, clip?.start, clip?.exportName, view?.project.status]);

  async function sendFile(file: File) {
    setError(null);
    setBusy("Reading the file");
    const form = new FormData();
    form.set("file", file);
    const response = await fetch("/api/projects", { method: "POST", body: form });
    const body = (await response.json()) as { project?: Project; error?: string };
    setBusy(null);
    if (!response.ok || !body.project) {
      setError(body.error ?? "The file was refused.");
      return;
    }
    await refreshList();
    await load(body.project.id);
  }

  async function sendUrl(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy("Fetching the source");
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = (await response.json()) as { project?: Project; error?: string };
    setBusy(null);
    if (!response.ok || !body.project) {
      setError(body.error ?? "That link was refused.");
      return;
    }
    setUrl("");
    await refreshList();
    await load(body.project.id);
  }

  async function mark() {
    if (!view) return;
    setError(null);
    const response = await fetch(`/api/projects/${view.project.id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetSeconds: target }),
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? "Could not mark cuts.");
      return;
    }
    setView((current) => current && ({
      ...current,
      project: { ...current.project, status: "analyzing", stage: "Reading the soundtrack", progress: 28, error: null },
    }));
  }

  async function patch(next: Partial<Clip>) {
    if (!clip) return;
    const response = await fetch(`/api/clips/${clip.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const body = (await response.json()) as { clip?: Clip; error?: string };
    if (!response.ok || !body.clip) {
      setError(body.error ?? "Could not save that change.");
      return;
    }
    setView((current) => current && ({
      ...current,
      clips: current.clips.map((item) => item.id === body.clip!.id ? body.clip! : item),
    }));
  }

  async function printCut() {
    if (!clip || !view) return;
    setError(null);
    const response = await fetch(`/api/clips/${clip.id}/export`, { method: "POST" });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(body.error ?? "Could not print this cut.");
      return;
    }
    setView((current) => current && ({
      ...current,
      clips: current.clips.map((item) => item.id === clip.id ? { ...item, status: "exporting", error: null } : item),
    }));
  }

  const previewSrc = useMemo(() => {
    if (!view) return "";
    if (clip?.exportName && clip.status === "exported") return `/api/media/${clip.id}`;
    if (view.project.duration > 0 && view.project.status !== "failed") return `/api/media/${view.project.id}`;
    return "";
  }, [view, clip]);

  const liveCue = clip?.cues?.find((cue) => playhead >= cue.start - 0.05 && playhead <= cue.end + 0.08);
  const liveText = clip?.exportName ? "" : liveCue?.text || (!clip?.cues?.length ? clip?.captionText : "");
  const tracked = view?.frame && clip && !clip.exportName
    ? planCrop(view.frame, clip.aspect, clip.start, clip.end)
    : null;
  const trackedKey = tracked?.keys.reduce((chosen, key) => (
    key.t <= Math.max(0, (playhead || clip!.start) - (clip?.start ?? 0)) ? key : chosen
  ), tracked.keys[0]);
  const framed = tracked && trackedKey && view?.frame && clip
    ? previewBox(view.frame.width, view.frame.height, {
      x: trackedKey.x,
      y: trackedKey.y,
      width: tracked.width,
      height: tracked.height,
    }, clip.aspect)
    : null;

  return (
    <div className="room">
      <header className="mast">
        <div className="mark">Ke<i>e</i>l</div>
        <div className="mast-note">Short cuts from a long take</div>
      </header>
      <main className="bench">
        <section className="gate">
          <p className="kicker">Source</p>
          <h1>Lay the long take on the bench.</h1>
          <p className="lede">A YouTube link or a file. Keel marks the passages worth a short frame.</p>
          <form className="intake" onSubmit={sendUrl}>
            <label>
              YouTube link
              <input
                type="url"
                value={url}
                placeholder="https://www.youtube.com/watch?v="
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
            <button className="btn" type="submit" disabled={!url || Boolean(busy)}>Fetch</button>
          </form>
          <div
            className={hot ? "drop hot" : "drop"}
            style={{ marginTop: 16 }}
            onDragOver={(event) => {
              event.preventDefault();
              setHot(true);
            }}
            onDragLeave={() => setHot(false)}
            onDrop={(event) => {
              event.preventDefault();
              setHot(false);
              const file = event.dataTransfer.files[0];
              if (file) void sendFile(file);
            }}
          >
            <div>
              <strong>Or drop a video</strong>
              <span>MP4, MOV, WebM, MKV</span>
              <div>
                <button className="btn ghost" type="button" onClick={() => fileRef.current?.click()}>
                  Choose a file
                </button>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void sendFile(file);
              }}
            />
          </div>
          <div className="lengths" role="group" aria-label="Target length">
            {LENGTHS.map((length) => (
              <button
                key={length}
                type="button"
                aria-pressed={target === length}
                onClick={() => setTarget(length)}
              >
                {length}s
              </button>
            ))}
          </div>
          <div className="actions">
            <button
              className="btn copper"
              type="button"
              disabled={!view || view.project.duration <= 0 || view.project.status === "analyzing"}
              onClick={() => void mark()}
            >
              Mark cuts
            </button>
          </div>
          {error ? <p className="warn" role="alert">{error}</p> : null}
          {busy ? <p className="note">{busy}</p> : null}
          <div className="shelf">
            {projects.length === 0 ? <p className="note">No sources yet.</p> : null}
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                aria-current={view?.project.id === project.id}
                onClick={() => void load(project.id)}
              >
                <span>{project.title}</span>
                <span>{project.status}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="stage" aria-live="polite">
          {!view || !previewSrc ? (
            <div className="empty">
              <div>
                <p className="kicker">{view?.project.stage ?? "Waiting"}</p>
                <h2>{view ? view.project.title : "The frame stays dark until a source arrives."}</h2>
                {view?.project.status === "analyzing" ? <Meter value={view.project.progress} /> : null}
                {view?.project.error ? <p className="warn">{view.project.error}</p> : null}
              </div>
            </div>
          ) : (
            <>
              <div className="timecode">
                <span>{view.project.title}</span>
                <span>{view.project.stage}</span>
              </div>
              {view.project.status === "analyzing" || clip?.status === "exporting" ? (
                <Meter value={clip?.status === "exporting" ? 70 : view.project.progress} />
              ) : <div className="meter" />}
              <div className="frame-wrap">
                <div className={`mat r-${(clip?.aspect ?? "9:16").replace(":", "-")}`}>
                  <video
                    ref={videoRef}
                    key={previewSrc}
                    src={previewSrc}
                    controls
                    playsInline
                    className={framed ? "tracked" : undefined}
                    style={framed ? {
                      width: `${framed.width}%`,
                      height: `${framed.height}%`,
                      left: `${framed.left}%`,
                      top: `${framed.top}%`,
                    } : undefined}
                    onTimeUpdate={(event) => {
                      setPlayhead(event.currentTarget.currentTime);
                      if (!clip || clip.exportName) return;
                      if (event.currentTarget.currentTime > clip.end) {
                        event.currentTarget.pause();
                        event.currentTarget.currentTime = clip.start;
                      }
                    }}
                  />
                  {liveText ? (
                    <div className={`caption-live ${clip?.captionStyle ?? "ledger"}`}>{liveText}</div>
                  ) : null}
                </div>
              </div>
              <div className="timecode">
                <span>{clip ? `${clock(clip.start)}  →  ${clock(clip.end)}` : "--"}</span>
                <span>{clip?.exportName ? "Printed master" : "Preview. Print burns the timed lines and the speaker frame."}</span>
              </div>
            </>
          )}
        </section>

        <aside className="slate">
          {!clip ? (
            <div>
              <p className="kicker">Cut</p>
              <h2>Nothing marked.</h2>
              <p className="reason">Choose a length, then mark the source. The strongest passages land here.</p>
            </div>
          ) : (
            <div>
              <p className="kicker">Cut · {Math.round(clip.score * 100)}</p>
              <label>
                Title
                <input
                  type="text"
                  value={clip.title}
                  maxLength={80}
                  onChange={(event) => {
                    const title = event.target.value;
                    setView((current) => current && ({
                      ...current,
                      clips: current.clips.map((item) => item.id === clip.id ? { ...item, title } : item),
                    }));
                  }}
                  onBlur={(event) => void patch({ title: event.target.value })}
                />
              </label>
              <p className="reason">{clip.reason}</p>
              <div className="pair">
                <label>
                  In
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    defaultValue={clip.start}
                    key={`${clip.id}-in-${clip.start}`}
                    onBlur={(event) => void patch({ start: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Out
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    defaultValue={clip.end}
                    key={`${clip.id}-out-${clip.end}`}
                    onBlur={(event) => void patch({ end: Number(event.target.value) })}
                  />
                </label>
              </div>
              <p className="kicker" style={{ marginTop: 16 }}>Frame</p>
              <div className="frames" role="group" aria-label="Aspect ratio">
                {ASPECTS.map((aspect) => (
                  <button
                    key={aspect}
                    type="button"
                    aria-pressed={clip.aspect === aspect}
                    onClick={() => void patch({ aspect })}
                  >
                    {aspect}
                  </button>
                ))}
              </div>
              <p className="kicker" style={{ marginTop: 16 }}>Caption</p>
              <div className="styles" role="group" aria-label="Caption style">
                {STYLES.map((style) => (
                  <button
                    key={style.id}
                    type="button"
                    aria-pressed={clip.captionStyle === style.id}
                    onClick={() => void patch({ captionStyle: style.id })}
                  >
                    {style.label}
                  </button>
                ))}
              </div>
              {clip.cues?.length ? (
                <div className="cues">
                  {clip.cues.map((cue, index) => (
                    <label key={`${clip.id}-${index}`}>
                      {clock(cue.start)}
                      <input
                        type="text"
                        defaultValue={cue.text}
                        key={`${clip.id}-${index}-${cue.text}`}
                        maxLength={160}
                        onBlur={(event) => {
                          const cues: Cue[] = clip.cues.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item);
                          void patch({ cues, captionText: cues.map((item) => item.text).join(" ") });
                        }}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <label style={{ marginTop: 10 }}>
                  Line to burn in
                  <textarea
                    value={clip.captionText}
                    maxLength={500}
                    onChange={(event) => {
                      const captionText = event.target.value;
                      setView((current) => current && ({
                        ...current,
                        clips: current.clips.map((item) => item.id === clip.id ? { ...item, captionText } : item),
                      }));
                    }}
                    onBlur={(event) => void patch({ captionText: event.target.value, cues: [] })}
                  />
                </label>
              )}
              {view?.project.warning ? <p className="warn">{view.project.warning}</p> : null}
              <div className="actions">
                <button
                  className="btn copper"
                  type="button"
                  disabled={clip.status === "exporting"}
                  onClick={() => void printCut()}
                >
                  {clip.status === "exporting" ? "Printing" : "Print cut"}
                </button>
                {clip.status === "exported" ? (
                  <a className="btn ghost" href={`/api/media/${clip.id}`} download={`${clip.title || "keel-cut"}.mp4`}>
                    Download
                  </a>
                ) : null}
              </div>
              {clip.error ? <p className="warn">{clip.error}</p> : null}
              {clip.status === "exported" ? <p className="good">Printed. The preview is the finished file.</p> : null}
            </div>
          )}
        </aside>

        <section className="strip" aria-label="Generated cuts">
          <div className="strip-head">
            <p className="kicker">Bench</p>
            <span className="note">{view?.clips.length ? `${view.clips.length} cuts` : "Empty"}</span>
          </div>
          {view?.clips.length ? (
            <div className="cuts">
              {view.clips.map((item) => (
                <button
                  key={item.id}
                  className="cut"
                  type="button"
                  aria-pressed={item.id === clip?.id}
                  onClick={() => setActiveId(item.id)}
                >
                  <span className="score">{item.aspect} · {Math.round(item.score * 100)}</span>
                  <b>{item.title}</b>
                  <span className="note">{clock(item.start)} – {clock(item.end)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty">Marked cuts will sit in a row here.</div>
          )}
        </section>
      </main>
    </div>
  );
}

function Meter({ value }: { value: number }) {
  return (
    <div className="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} role="progressbar">
      <span style={{ width: `${Math.max(4, Math.min(100, value))}%` }} />
    </div>
  );
}
