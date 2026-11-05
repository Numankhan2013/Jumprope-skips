"""Build the spoken-cue voice pack: one small MP3 'sprite' with every word the cues need,
plus voice.json with where each word starts. The app stitches words into sentences such as
"Two hundred skips. Last one hundred in forty eight seconds." and plays them through Web
Audio, which mixes with music instead of pausing it (unlike the phone's text-to-speech).

    pip install piper-tts
    python web/make_voice.py /path/to/en_US-lessac-medium.onnx      (voice from rhasspy/piper-voices)
"""
import json
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
OUT = HERE / "voice"
RATE = 22050

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
# phrases are recorded whole where they're always said together (sounds more natural)
WORDS = ONES + TENS + ["hundred", "thousand", "skips", "skip", "last", "in", "second", "seconds", "minute", "minutes",
                       "hour", "hours", "total time", "goal reached", "today", "skips today", "pace", "per minute"]


def speak(model: str, text: str, path: Path) -> None:
    subprocess.run([sys.executable, "-m", "piper", "-m", model, "-f", str(path), "--sentence-silence", "0"],
                   input=text.encode(), check=True, capture_output=True)


def load(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)


def trim(x: np.ndarray, thresh: float = 300, pad: int = int(0.02 * RATE)) -> np.ndarray:
    loud = np.flatnonzero(np.abs(x) > thresh)
    if not len(loud):
        return x[:0]
    return x[max(0, loud[0] - pad): loud[-1] + pad]


def main(model: str) -> None:
    OUT.mkdir(exist_ok=True)
    gap = np.zeros(int(0.25 * RATE), np.float32)  # silence between words in the sprite (absorbs MP3 padding)
    pieces, index, pos = [gap], {}, len(gap)
    with tempfile.TemporaryDirectory() as tmp:
        for word in WORDS:
            wav = Path(tmp) / "w.wav"
            speak(model, word, wav)
            clip = trim(load(wav))
            index[word] = [round(pos / RATE, 4), round(len(clip) / RATE, 4)]
            pieces += [clip, gap]
            pos += len(clip) + len(gap)
        audio = np.concatenate(pieces)
        audio = (audio / max(1.0, np.abs(audio).max()) * 0.92 * 32767).astype(np.int16)
        raw = Path(tmp) / "sprite.wav"
        with wave.open(str(raw), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(audio.tobytes())
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-ac", "1", "-ar", str(RATE), "-b:a", "48k",
                        str(OUT / "voice.mp3")], check=True)
    (OUT / "voice.json").write_text(json.dumps({"file": "voice/voice.mp3", "words": index}, indent=0))
    print(f"{len(index)} words, {pos / RATE:.1f} s, {(OUT / 'voice.mp3').stat().st_size // 1024} KB")


if __name__ == "__main__":
    main(sys.argv[1])
