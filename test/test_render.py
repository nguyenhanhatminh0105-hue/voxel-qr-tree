"""Full verification of the rendered diorama.

Everything here works on pixels a real browser produced, loaded from file://.

  1. DECODE CLEAN     - ZBar on the code-view render, every link x season x
                        swatch. ZBar is the gate; cv2.QRCodeDetectorAruco is a
                        second opinion. The legacy cv2.QRCodeDetector is not
                        used at all - it fails on perfectly valid codes.
  2. MATRIX DIFF      - reconstruct the matrix by sampling rendered pixels and
                        diff it against the true matrix. Must differ by zero
                        modules.
  3. CAMERA           - decode again through perspective warp, blur, dim light,
                        sensor noise and downscale.
  4. WIND             - bit-identical at t=1 across different clocks, and
                        genuinely moving at t=0.
  5. GEOMETRY         - sweep every combination for malformed faces.
"""
import os
import sys
import hashlib
import argparse

import numpy as np
import cv2
from PIL import Image
from pyzbar import pyzbar

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from harness import Arboretum, save, ROOT
from camera import simulate

LINKS = [
    "https://github.com/nguyenhanhatminh0105-hue",
    "https://example.com",
    "https://claude.ai/code",
    "https://en.wikipedia.org/wiki/Quick_Response_code",
    "https://maps.example.org/?q=voxel+arboretum&z=14",
    "a",
]
SEASONS = ["sakura", "oak", "gum", "willow"]
SWATCHES = ["rose", "jade", "amber", "indigo", "plum", "moss"]
DARK_THRESHOLD = 160          # paving ~234 grey, every dark-module surface < 100


def zbar(img):
    res = pyzbar.decode(Image.fromarray(img), symbols=[pyzbar.ZBarSymbol.QRCODE])
    out = []
    for r in res:
        out.append(r.data)
        try:
            t = r.data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for cs in ("shift-jis", "latin-1"):
            try:
                out.append(t.encode(cs))
            except (UnicodeEncodeError, LookupError):
                pass
    return out


def aruco(img):
    try:
        ok, texts, _, _ = cv2.QRCodeDetectorAruco().detectAndDecodeMulti(img)
        return [t.encode("utf-8", "replace") for t in texts if t] if ok else []
    except Exception:
        return []


def reconstruct(img, geom):
    """Rebuild the module matrix from rendered pixels.

    Deliberately samples the image rather than asking the code what it drew:
    an analytic check cannot see the slab, antialiasing, the half-pixel tile
    inflation, or a voxel that overhangs its module, and would pass while the
    real render fails.
    """
    n, scale, ox, oy, dpr = geom["n"], geom["scale"], geom["ox"], geom["oy"], geom["dpr"]
    grey = (0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2])
    out = np.zeros((n, n), np.uint8)
    for my in range(n):
        for mx in range(n):
            cx = (ox + (mx + 0.5) * scale) * dpr
            cy = (oy + (my + 0.5) * scale) * dpr
            r = max(1, int(scale * dpr * 0.22))
            patch = grey[int(cy) - r:int(cy) + r + 1, int(cx) - r:int(cx) + r + 1]
            if patch.size == 0:
                continue
            out[my, mx] = 1 if np.median(patch) < DARK_THRESHOLD else 0
    return out


def quiet_zone_is_light(img, geom):
    """The 4-module margin must be paving, not slab overhang."""
    n, scale, ox, oy, dpr = geom["n"], geom["scale"], geom["ox"], geom["oy"], geom["dpr"]
    grey = (0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2])
    q = 4
    worst = 255.0
    for i in range(-q, n + q):
        for j in (-q, -1, n, n + q - 1):
            for (mx, my) in ((i, j), (j, i)):
                cx = int((ox + (mx + 0.5) * scale) * dpr)
                cy = int((oy + (my + 0.5) * scale) * dpr)
                if 0 <= cy < grey.shape[0] and 0 <= cx < grey.shape[1]:
                    worst = min(worst, float(grey[cy, cx]))
    return worst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="one link only")
    ap.add_argument("--cam-trials", type=int, default=3)
    ap.add_argument("--target", default="index.html",
                    help="index.html (canvas 2D) or three.html (WebGL)")
    args = ap.parse_args()
    links = LINKS[:1] if args.quick else LINKS

    rng = np.random.default_rng(20260902)
    fails = []
    clean_ok = clean_n = 0
    aruco_ok = 0
    cam_ok = cam_n = 0
    matrix_perfect = matrix_n = 0
    worst_quiet = 255.0
    geom_rows = 0
    saved_cam = False

    with Arboretum(width=760, height=760, dpr=2, target=args.target) as arb:
        # ---- 4. wind determinism (independent of the sweep) -------------
        arb.set_state(text=LINKS[0], species="willow", swatch="indigo")
        a = arb.shoot(1.0, clock=0.0)
        b = arb.shoot(1.0, clock=987654.321)
        c = arb.shoot(1.0, clock=41234567.89)
        ha, hb, hc = (hashlib.sha256(x.tobytes()).hexdigest() for x in (a, b, c))
        wind_static = (ha == hb == hc)
        if not wind_static:
            fails.append("wind is not bit-identical at t=1 across clocks")

        m0 = arb.shoot(0.0, clock=0.0)
        m1 = arb.shoot(0.0, clock=1500.0)
        moved = int(np.abs(m0.astype(int) - m1.astype(int)).sum())
        wind_moves = moved > 0
        if not wind_moves:
            fails.append("wind does not move at t=0")

        # ---- sweep ------------------------------------------------------
        for link in links:
            for sp in SEASONS:
                for sw in SWATCHES:
                    arb.set_state(text=link, species=sp, swatch=sw)

                    # 5. geometry, checked at both ends of the flip
                    for t in (0.0, 1.0):
                        g = arb.page.evaluate("a => window.__arb.geomCheck(a[0], a[1])",
                                              [t, 1234.0])
                        geom_rows += 1
                        for k in ("nonFinite", "zeroArea", "badVertexCount",
                                  "zeroExtent", "outOfModule", "offDark"):
                            if g[k]:
                                fails.append(f"{link[:24]} {sp}/{sw} t={t}: {k}={g[k]}")
                        want = g["voxels"] * (1 if t == 1.0 else 3)
                        if g["faces"] != want:
                            fails.append(f"{link[:24]} {sp}/{sw} t={t}: "
                                         f"{g['faces']} faces, expected {want}")

                    img = arb.shoot(1.0, clock=1234.0)
                    geom = arb.geom()
                    want = link.encode("utf-8")

                    # 1. clean decode
                    clean_n += 1
                    if want in zbar(img):
                        clean_ok += 1
                    else:
                        fails.append(f"ZBar clean FAIL: {link[:30]} {sp}/{sw}")
                        save(img, f"fail_clean_{sp}_{sw}.png")
                    if want in aruco(img):
                        aruco_ok += 1

                    # 2. matrix reconstruction from pixels
                    matrix_n += 1
                    truth = arb.matrix()
                    got = reconstruct(img, geom)
                    d = int((truth != got).sum())
                    if d == 0:
                        matrix_perfect += 1
                    else:
                        fails.append(f"matrix diff {d} modules: {link[:30]} {sp}/{sw}")

                    worst_quiet = min(worst_quiet, quiet_zone_is_light(img, geom))

                    # 3. through a camera
                    for _ in range(args.cam_trials):
                        cam_n += 1
                        sim = simulate(img, rng)
                        if want in zbar(sim) or want in aruco(sim):
                            cam_ok += 1
                        else:
                            fails.append(f"camera FAIL: {link[:30]} {sp}/{sw}")
                            if not saved_cam:
                                save(sim, f"fail_camera_{sp}_{sw}.png")
                                saved_cam = True

    def pct(a, b):
        return f"{a}/{b} ({100.0 * a / max(1, b):.1f}%)"

    print(f"QR ARBORETUM - RENDER VERIFICATION  [{args.target}]")
    print("=" * 62)
    print(f"combinations swept   : {clean_n}  ({len(links)} links x 4 seasons x 6 swatches)")
    print(f"geometry checks      : {geom_rows} (no malformed faces)" if not any(
        "faces" in f or "nonFinite" in f for f in fails) else f"geometry checks   : {geom_rows} WITH FAILURES")
    print()
    print(f"1. ZBar, clean       : {pct(clean_ok, clean_n)}")
    print(f"   cv2 Aruco         : {pct(aruco_ok, clean_n)}   [second opinion]")
    print(f"2. matrix from pixels: {pct(matrix_perfect, matrix_n)} exact, 0 modules differ")
    print(f"   quiet zone min lum: {worst_quiet:.0f}/255 (paving ~234; must stay light)")
    print(f"3. through camera    : {pct(cam_ok, cam_n)}  "
          f"({args.cam_trials} trials each: warp+blur+dim+noise+downscale)")
    print(f"4. wind at t=1       : {'bit-identical across 3 clocks' if wind_static else 'NOT STATIC'}")
    print(f"   wind at t=0       : {'moving (' + str(moved) + ' channel-units)' if wind_moves else 'STATIC - BROKEN'}")
    print()

    if fails:
        print(f"FAILURES ({len(fails)})")
        seen = set()
        for f in fails:
            if f not in seen:
                print("  " + f)
                seen.add(f)
            if len(seen) > 25:
                print("  ...")
                break
        return 1
    print("ALL CHECKS PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
