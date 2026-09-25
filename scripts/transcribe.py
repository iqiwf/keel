"""Transcribe speech with a local Whisper model. Prints one JSON object. No API key."""

import json
import os
import sys


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Missing audio path.\n")
        return 1
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else os.environ.get("WHISPER_MODEL", "small")
    language = os.environ.get("WHISPER_LANGUAGE") or None
    if language == "":
        language = None
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write("faster-whisper is not installed for the local transcription.\n")
        return 1
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8", local_files_only=True)
    except Exception:
        model = WhisperModel(model_name, device="cpu", compute_type="int8", local_files_only=False)
    clips = None
    if len(sys.argv) > 3 and sys.argv[3]:
        clips = [float(part) for part in sys.argv[3].split(",") if part]
        if len(clips) < 2:
            clips = None
    options = {
        "word_timestamps": True,
        "language": language,
        "beam_size": 5,
        "vad_filter": True,
    }
    if clips:
        options["clip_timestamps"] = clips
    try:
        segments, info = model.transcribe(sys.argv[1], **options)
    except Exception:
        options["vad_filter"] = False
        segments, info = model.transcribe(sys.argv[1], **options)
    words = []
    texts = []
    for segment in segments:
        texts.append(segment.text.strip())
        for word in segment.words or []:
            text = (word.word or "").strip()
            if not text or word.start is None:
                continue
            words.append({
                "text": text,
                "start": round(float(word.start), 2),
                "end": round(float(word.end if word.end is not None else word.start), 2),
            })
    sys.stdout.write(json.dumps({
        "language": getattr(info, "language", None) or language or "und",
        "text": " ".join(part for part in texts if part),
        "words": words,
        "model": model_name,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
