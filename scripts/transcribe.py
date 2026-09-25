"""Transcribe speech with a local Whisper model. Prints one JSON object. No API key.

Each requested window is decoded on its own. Word times from that clip are local,
then shifted by the window start so the JSON is always on the source timeline.
"""

import json
import os
import sys
import tempfile
import wave

import numpy as np


def parse_windows(raw):
    if not raw:
        return []
    parts = [float(part) for part in raw.split(",") if part]
    if len(parts) < 2 or len(parts) % 2:
        raise ValueError("Windows must be start,end pairs.")
    windows = []
    for index in range(0, len(parts), 2):
        start, end = parts[index], parts[index + 1]
        if end <= start:
            raise ValueError("A window must end after it starts.")
        windows.append((start, end))
    return windows


def load_audio(path):
    from faster_whisper.audio import decode_audio
    return decode_audio(path, sampling_rate=16000)


def write_clip(samples, rate, path):
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())


def transcribe_media(model, path, options):
    try:
        segments, info = model.transcribe(path, **options)
    except Exception:
        fallback = dict(options)
        fallback["vad_filter"] = False
        segments, info = model.transcribe(path, **fallback)
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
                "start": float(word.start),
                "end": float(word.end if word.end is not None else word.start),
            })
    return words, texts, info


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Missing audio path.\n")
        return 1
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else os.environ.get("WHISPER_MODEL", "small")
    language = os.environ.get("WHISPER_LANGUAGE") or None
    if language == "":
        language = None
    try:
        windows = parse_windows(sys.argv[3] if len(sys.argv) > 3 else "")
    except ValueError as error:
        sys.stderr.write(f"{error}\n")
        return 1
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write("faster-whisper is not installed for the local transcription.\n")
        return 1
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8", local_files_only=True)
    except Exception:
        model = WhisperModel(model_name, device="cpu", compute_type="int8", local_files_only=False)
    options = {
        "word_timestamps": True,
        "language": language,
        "beam_size": 5,
        "vad_filter": True,
    }
    words = []
    texts = []
    info = None
    if not windows:
        raw_words, texts, info = transcribe_media(model, sys.argv[1], options)
        words = [{
            "text": word["text"],
            "start": round(word["start"], 2),
            "end": round(max(word["start"], word["end"]), 2),
        } for word in raw_words]
    else:
        audio = load_audio(sys.argv[1])
        rate = 16000
        total = audio.shape[0]
        for start, end in windows:
            left = max(0, int(start * rate))
            right = min(total, int(end * rate))
            if right - left < rate // 5:
                continue
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
                clip_path = handle.name
            try:
                write_clip(audio[left:right], rate, clip_path)
                local_words, local_texts, info = transcribe_media(model, clip_path, options)
            finally:
                try:
                    os.remove(clip_path)
                except OSError:
                    pass
            texts.extend(local_texts)
            for word in local_words:
                words.append({
                    "text": word["text"],
                    "start": round(word["start"] + start, 2),
                    "end": round(max(word["start"], word["end"]) + start, 2),
                })
    words.sort(key=lambda word: word["start"])
    sys.stdout.write(json.dumps({
        "language": getattr(info, "language", None) or language or "und",
        "text": " ".join(part for part in texts if part),
        "words": words,
        "model": model_name,
        "timeline": "absolute",
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
