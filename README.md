# Keel

Keel turns a long video into short cuts for vertical, square, and wide frames. Drop a file or paste a YouTube link, mark the passages worth keeping, tune the trim, caption, and frame, then print a file you can download.

This is an independent cutting-room tool. It is not affiliated with any other clipping product.

## What you can do

- Paste a YouTube link or upload an MP4, MOV, WebM, or MKV.
- Mark several cuts around a chosen length: 15, 30, 45, or 60 seconds.
- Preview each cut, then change the in and out points, title, caption, caption style, and aspect ratio (`9:16`, `1:1`, `16:9`).
- Print a reframed MP4 with the caption burned in, then download it.

## Run it

```bash
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:3000.

You need `ffmpeg` and `ffprobe` on your PATH. YouTube links also need `yt-dlp`. Uploads work without `yt-dlp`.

## AI providers

The provider is chosen on the server. The browser never sees an API key.

| `AI_PROVIDER` | Behavior |
| --- | --- |
| `mock` (default) | Builds a timed transcript from the video length and picks spaced cuts. No network call. |
| `openai` | Extracts speech, transcribes it, then asks a chat model for cuts. Requires `OPENAI_API_KEY`. |

Swap the implementation by editing `lib/ai` and returning a new `AiProvider` from `lib/ai/index.ts`.

## Data

Masters, prints, and the project index live in `.data/`, which is gitignored. Set `DATA_DIR` to move that folder. Set `MAX_UPLOAD_MB` to change the upload cap (default 300).

## Tests

```bash
npm test
```

The suite checks URL and file validation, the mock marker, and a real ffmpeg print from a generated master.
