"""Sample faces and motion. Prints one JSON object to stdout. No network."""

import json
import sys

import cv2


def boxes(cascade, gray, minimum):
    output = []
    for image in (gray, cv2.equalizeHist(gray)):
        found = cascade.detectMultiScale(image, scaleFactor=1.08, minNeighbors=4, minSize=(minimum, minimum))
        for x, y, w, h in found:
            output.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})
    return output


def merge(faces):
    kept = []
    for face in sorted(faces, key=lambda item: item["w"] * item["h"], reverse=True):
        if any(overlap(face, other) > 0.35 for other in kept):
            continue
        kept.append(face)
    return kept[:4]


def overlap(a, b):
    ax2, ay2 = a["x"] + a["w"], a["y"] + a["h"]
    bx2, by2 = b["x"] + b["w"], b["y"] + b["h"]
    iw = max(0, min(ax2, bx2) - max(a["x"], b["x"]))
    ih = max(0, min(ay2, by2) - max(a["y"], b["y"]))
    union = a["w"] * a["h"] + b["w"] * b["h"] - iw * ih
    return 0 if union <= 0 else (iw * ih) / union


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Missing video path.\n")
        return 1
    cap = cv2.VideoCapture(sys.argv[1])
    if not cap.isOpened():
        sys.stderr.write("Could not open the video for speaker tracking.\n")
        return 1
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 25) or 25
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frames / fps if frames > 0 else 0
    step = max(1, int(round(fps / (4 if duration <= 15 * 60 else 2))))
    root = cv2.data.haarcascades
    frontal = cv2.CascadeClassifier(root + "haarcascade_frontalface_default.xml")
    profile = cv2.CascadeClassifier(root + "haarcascade_profileface.xml")
    minimum = max(24, width // 48)
    samples = []
    previous = None
    index = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if index % step == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = boxes(frontal, gray, minimum) + boxes(profile, gray, minimum)
            small = cv2.resize(gray, (160, 90))
            motion = None
            if previous is not None:
                diff = cv2.absdiff(small, previous)
                _, mask = cv2.threshold(diff, 24, 255, cv2.THRESH_BINARY)
                moment = cv2.moments(mask)
                if moment["m00"] > 160 * 90 * 0.01:
                    motion = {
                        "x": round(moment["m10"] / moment["m00"] / 160 * width, 2),
                        "y": round(moment["m01"] / moment["m00"] / 90 * height, 2),
                    }
            previous = small
            samples.append({"t": round(index / fps, 3), "faces": merge(faces), "motion": motion})
        index += 1
    cap.release()
    sys.stdout.write(json.dumps({"width": width, "height": height, "samples": samples}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
