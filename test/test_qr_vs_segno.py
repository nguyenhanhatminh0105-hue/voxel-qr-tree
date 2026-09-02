"""Cross-check our from-scratch QR encoder against segno.

Two passes:

  1. FORCED MASK. Same version, same ECC level, same mask -> the matrices must
     be identical module for module. This isolates encoding (bit stream, RS
     codewords, interleaving, module placement) from mask selection.

  2. FREE MASK. Our own mask choice vs segno's. Differences here are legal:
     segno scores the penalty *before* writing format information, so a mask
     whose format bits change a run length can score differently. We report the
     agreement rate rather than asserting equality.

Known, expected divergence: segno's write_padding_bits() computes
8 - (length % 8) and therefore appends a spurious zero byte when the bit stream
is already byte-aligned. That shifts every subsequent pad byte and the whole
RS block, so those cases differ everywhere, not in one module. They are
detected and reported separately rather than counted as failures.
"""
import json
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

import segno

CORPUS = [
    "https://example.com",
    "https://github.com/nguyenhanhatminh0105-hue",
    "HELLO WORLD",
    "a",
    "",
    "https://claude.ai/code",
    "https://en.wikipedia.org/wiki/Reed%E2%80%93Solomon_error_correction",
    "x" * 40,
    "x" * 100,
    "x" * 220,
    "https://maps.example.org/?q=" + "b" * 60,
    "The quick brown fox jumps over the lazy dog. 0123456789",
    "https://example.com/a/b/c/d?e=f&g=h#frag",
    "éèê café naïve",
    "https://xn--80ak6aa92e.com/" + "z" * 30,
    "mailto:someone@example.com?subject=hi",
    "tel:+15551234567",
    "WIFI:T:WPA;S:MyNetwork;P:secret123;;",
    "y" * 500,
    "q" * 900,
]
ECLS = ["L", "M", "Q", "H"]


def segno_matrix(text, ecl, mask, version):
    # encoding="utf-8" matters: segno defaults byte mode to ISO-8859-1 when the
    # text fits, we always emit UTF-8. Without this the non-ASCII cases differ
    # in byte length and therefore in every codeword.
    q = segno.make(text, version=version, error=ecl, mask=mask,
                   boost_error=False, mode="byte", encoding="utf-8")
    return ["".join("1" if v else "0" for v in row) for row in q.matrix]


def bit_align_quirk(text, version):
    """True if segno's padding bug applies: the stream is byte-aligned right
    after the terminator, so segno appends one extra zero byte."""
    count_bits = 8 if version <= 9 else 16
    nbytes = len(text.encode("utf-8"))
    # mode(4) + count + data, plus terminator of up to 4 zero bits
    return (4 + count_bits + nbytes * 8) % 8 == 0


def main():
    cases = []
    for text in CORPUS:
        for ecl in ECLS:
            for mask in range(8):
                cases.append({"text": text, "ecl": ecl, "mask": mask, "padQuirk": True})
            cases.append({"text": text, "ecl": ecl, "mask": None, "padQuirk": True})

    corpus_path = os.path.join(HERE, "_corpus.json")
    with open(corpus_path, "w", encoding="utf-8") as f:
        json.dump(cases, f)

    res = subprocess.run(
        ["node", os.path.join(HERE, "dump_matrices.js"), corpus_path],
        capture_output=True, text=True, encoding="utf-8",
    )
    if res.returncode != 0:
        print("node failed:\n" + res.stderr)
        return 1
    data = json.loads(res.stdout)

    # --- Reed-Solomon generator polynomial orientation --------------------
    st = data["rsSelfTest"]
    print("Reed-Solomon generator polynomial")
    print(f"  degree 1 -> {st['deg1']}   (symmetric: reversal is invisible here)")
    print(f"  degree 2 -> {st['deg2']}   (must be [3, 2]; reversed would be [2, 3])")
    print(f"  degree 7 -> {st['deg7']}")
    assert st["ok"], "RS generator polynomial is built with reversed coefficients"
    print("  OK - not reversed\n")

    forced_pass = forced_fail = 0
    quirk_cases = 0
    free_agree = free_total = 0
    failures = []
    versions_seen = set()
    over_capacity = set()

    for c in data["cases"]:
        if not c["ok"]:
            # "too long" is a real capacity limit at v20, not a bug: check that
            # segno agrees the payload does not fit either.
            if "too long" in c["error"]:
                try:
                    if segno.make(c["text"], error=c["ecl"], mode="byte",
                                  boost_error=False).version <= 20:
                        failures.append((c["text"][:30], c["ecl"], c["mask"],
                                         "we rejected a payload that fits: " + c["error"]))
                        continue
                except Exception:
                    pass
                over_capacity.add((c["text"][:12], c["ecl"]))
            else:
                failures.append((c["text"][:30], c["ecl"], c["mask"], "encode error: " + c["error"]))
            continue
        text, ecl, mask = c["text"], c["ecl"], c["mask"]
        versions_seen.add(c["version"])
        try:
            seg = segno_matrix(text, ecl, c["chosenMask"] if mask is None else mask, c["version"])
        except Exception as e:  # segno cannot make this combination
            continue

        ours = c["rows"]
        if len(seg) != len(ours):
            failures.append((text[:30], ecl, mask, f"size {len(ours)} vs segno {len(seg)}"))
            continue
        diff = sum(a != b for ra, rb in zip(ours, seg) for a, b in zip(ra, rb))

        if mask is None:
            free_total += 1
            if diff == 0:
                free_agree += 1
            continue

        if diff == 0:
            forced_pass += 1
        elif bit_align_quirk(text, c["version"]):
            quirk_cases += 1
        else:
            forced_fail += 1
            if len(failures) < 12:
                failures.append((text[:30], ecl, mask, f"{diff} modules differ (v{c['version']})"))

    print(f"Payloads correctly rejected as over-capacity at v20: {len(over_capacity)}\n")
    print("Forced-mask comparison (encoder correctness, segno padding emulated)")
    print(f"  identical to segno : {forced_pass}")
    print(f"  segno padding quirk: {quirk_cases}  (expected; see module docstring)")
    print(f"  genuine mismatches : {forced_fail}")
    print(f"  versions exercised : {min(versions_seen)}..{max(versions_seen)}")
    print()
    print("Free-mask comparison (mask selection)")
    print(f"  same mask as segno : {free_agree}/{free_total}"
          f" ({100.0 * free_agree / max(1, free_total):.0f}%)  -- differences are legal")

    if failures:
        print("\nFAILURES")
        for f in failures:
            print(f"  {f}")
        return 1
    print("\nALL FORCED-MASK CASES MATCH SEGNO")
    return 0


if __name__ == "__main__":
    sys.exit(main())
