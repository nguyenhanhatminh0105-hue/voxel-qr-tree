"""Decode our shipped matrices (real padding, not segno's quirk) with ZBar.

The segno comparison runs with segno's padding bug emulated, so it proves our
placement/RS/masking match but says nothing about the stream we actually ship.
This closes that gap: render each matrix as a plain black-and-white PNG and
decode it.

pyzbar (ZBar) is the primary oracle - it is the engine behind many real scanner
apps. cv2.QRCodeDetectorAruco is a second opinion. The legacy
cv2.QRCodeDetector is deliberately NOT used: it fails on perfectly valid codes.
"""
import json
import os
import subprocess
import sys

import numpy as np

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
from PIL import Image
from pyzbar import pyzbar
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))

CORPUS = [
    "https://example.com",
    "https://github.com/nguyenhanhatminh0105-hue/qr-arboretum",
    "https://claude.ai/code",
    "a",
    "HELLO WORLD 12345",
    "https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction",
    "mailto:someone@example.com?subject=hi",
    "WIFI:T:WPA;S:MyNetwork;P:secret123;;",
    "éèê café naïve",
    "x" * 40,
    "x" * 120,
    "x" * 260,
    "x" * 480,
    "x" * 780,
]
ECLS = ["L", "M", "Q", "H"]
SCALE = 6
QUIET = 4


def matrix_to_image(rows, scale=SCALE, quiet=QUIET):
    n = len(rows)
    a = np.ones((n + quiet * 2, n + quiet * 2), dtype=np.uint8) * 255
    for y, r in enumerate(rows):
        for x, ch in enumerate(r):
            if ch == "1":
                a[y + quiet, x + quiet] = 0
    return np.kron(a, np.ones((scale, scale), dtype=np.uint8))


def zbar_decode(img):
    """Return raw payload bytes. Comparison is done on bytes, not str: absent an
    ECI header the QR spec says byte mode is ISO-8859-1, so ZBar labels our
    UTF-8 payload as latin-1 and str comparison would spuriously fail on
    non-ASCII text. The bytes themselves round-trip exactly."""
    res = pyzbar.decode(Image.fromarray(img), symbols=[pyzbar.ZBarSymbol.QRCODE])
    out = []
    for r in res:
        out.append(r.data)
        # ZBar has already transcoded the payload using whatever charset it
        # guessed (Shift-JIS is its default for QR, since the format is
        # Japanese in origin). Undo the plausible guesses so we can compare the
        # bytes we actually encoded. Real apps avoid this ambiguity with an ECI
        # header; ASCII URLs - the entire point of this app - never hit it.
        try:
            txt = r.data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for cs in ("shift-jis", "latin-1", "cp932"):
            try:
                out.append(txt.encode(cs))
            except (UnicodeEncodeError, LookupError):
                pass
    return out


def aruco_decode(img):
    try:
        d = cv2.QRCodeDetectorAruco()
        ok, texts, _, _ = d.detectAndDecodeMulti(img)
        return [t for t in texts if t] if ok else []
    except Exception:
        return []


def main():
    cases = [{"text": t, "ecl": e, "mask": None} for t in CORPUS for e in ECLS]
    corpus_path = os.path.join(HERE, "_corpus_decode.json")
    with open(corpus_path, "w", encoding="utf-8") as f:
        json.dump(cases, f)

    res = subprocess.run(["node", os.path.join(HERE, "dump_matrices.js"), corpus_path],
                         capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        print("node failed:\n" + res.stderr)
        return 1
    data = json.loads(res.stdout)

    zbar_ok = aruco_ok = total = 0
    versions = set()
    failures = []
    for c in data["cases"]:
        if not c["ok"]:
            if "too long" not in c["error"]:
                failures.append((c["text"][:24], c["ecl"], c["error"]))
            continue
        total += 1
        versions.add(c["version"])
        img = matrix_to_image(c["rows"])
        want = c["text"].encode("utf-8")
        z = zbar_decode(img)
        a = aruco_decode(img)
        if want in z:
            zbar_ok += 1
        else:
            failures.append((c["text"][:24], c["ecl"], f"v{c['version']} ZBar got {z!r}"))
        if c["text"] in a or want in [t.encode("utf-8", "replace") for t in a]:
            aruco_ok += 1

    print(f"cases                : {total}")
    print(f"versions exercised   : {min(versions)}..{max(versions)}")
    print(f"ZBar decoded         : {zbar_ok}/{total} ({100.0*zbar_ok/max(1,total):.1f}%)")
    print(f"cv2 Aruco decoded    : {aruco_ok}/{total} ({100.0*aruco_ok/max(1,total):.1f}%)"
          "   [second opinion; ZBar is the gate]")
    if failures:
        print("\nFAILURES")
        for f in failures[:20]:
            print(" ", f)
        return 1
    print("\nALL MATRICES DECODE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
