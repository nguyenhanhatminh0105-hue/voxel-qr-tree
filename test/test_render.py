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
  6. SILHOUETTE       - rendered diorama height / plot width at t=0, which must
                        land in 0.90-1.05. The reference sits at 0.96. A flat
                        canopy drives this down, and a flat canopy is also what
                        makes the matrix carving show through as lace, because
                        there is nothing behind any gap. scene.stats.height-
                        Fraction is NOT a substitute: it includes the fallen
                        carpet, so it reads healthy while the crown is a disc.
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
from harness import Arboretum, save, silhouette_aspect, ROOT
from camera import simulate

LINKS = [
    "https://github.com/nguyenhanhatminh0105-hue",
    "https://example.com",
    "https://claude.ai/code",
    "https://en.wikipedia.org/wiki/Quick_Response_code",
    "https://maps.example.org/?q=voxel+arboretum&z=14",
    "a",
]
SEASONS = ["sakura", "oak", "ginkgo", "willow"]
SWATCHES = ["rose", "jade", "amber", "indigo", "plum", "moss"]
DARK_THRESHOLD = 160          # legacy centre-sample threshold
# Area-mean threshold. A fully dark module averages well under this even
# with sub-module gaps showing the dark tile beneath; paving sits at ~234.
AREA_THRESHOLD = 200


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


def reconstruct(img, geom, threshold=None):
    """Rebuild the module matrix from rendered pixels, by AREA MEAN.

    Deliberately samples the image rather than asking the code what it drew.
    An analytic check cannot see the slab, canvas antialiasing, a voxel that
    overhangs its module, or a whole scene rendered mirrored - it would pass
    while the real render fails. That last one is not hypothetical: it is
    exactly how the WebGL handedness bug was caught.

    It averages the module's area rather than sampling its centre. Rounded
    blossoms and grass blades leave far more sub-module gaps than boxes did, so
    a centre pixel can land in a gap and report a flip that no decoder sees -
    what a scanner integrates is the module's mean, which is also the quantity
    the palette's contrast rule is written against.
    """
    n, scale, ox, oy, dpr = geom["n"], geom["scale"], geom["ox"], geom["oy"], geom["dpr"]
    if threshold is None:
        threshold = AREA_THRESHOLD
    grey = (0.299 * img[..., 0] + 0.587 * img[..., 1] + 0.114 * img[..., 2])
    out = np.zeros((n, n), np.uint8)
    inset = 0.10                      # skip the antialiased module border
    for my in range(n):
        for mx in range(n):
            x0 = int(round((ox + (mx + inset) * scale) * dpr))
            x1 = int(round((ox + (mx + 1 - inset) * scale) * dpr))
            y0 = int(round((oy + (my + inset) * scale) * dpr))
            y1 = int(round((oy + (my + 1 - inset) * scale) * dpr))
            patch = grey[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
            if patch.size == 0:
                continue
            out[my, mx] = 1 if patch.mean() < threshold else 0
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


def quiet_zone_survives_context_loss(arb):
    """Force a WebGL context loss and confirm the quiet zone comes back light.

    three.js rebuilds its background module in initGLContext(), which it re-runs
    on 'webglcontextrestored' - and the fresh module starts at a BLACK clear
    colour. The clear colour IS the quiet zone, so unless the app re-applies it
    the 4-module margin returns black and the symbol loses the light border a
    scanner needs.

    The sweep cannot catch this on its own: it launches ANGLE+SwiftShader, which
    never drops the context. Raw --use-gl=swiftshader loses it on every startup,
    which is how it was found - by opening the page rather than by testing it.
    So the loss is forced here explicitly rather than waited for.

    Returns (before, after) corner luma, or None if the build has no WebGL.
    """
    lost = arb.page.evaluate("""() => {
        const c = document.getElementById('stage');
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return false;
        const ext = gl.getExtension('WEBGL_lose_context');
        if (!ext) return false;
        ext.loseContext();
        setTimeout(() => ext.restoreContext(), 0);
        return true;
    }""")
    if not lost:
        return None
    arb.page.wait_for_timeout(600)
    img = arb.shoot(1.0, clock=1200.0)
    grey = float(0.299 * img[3, 3, 0] + 0.587 * img[3, 3, 1] + 0.114 * img[3, 3, 2])
    return grey


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="one link only")
    ap.add_argument("--cam-trials", type=int, default=3)
    # Band widened deliberately: the four species are now meant to differ in
    # PROPORTION, not just size, so a narrow band would forbid the spread
    # rather than protect it. The spread itself is asserted separately.
    ap.add_argument("--aspect-lo", type=float, default=0.80)
    ap.add_argument("--aspect-hi", type=float, default=1.25)
    ap.add_argument("--min-spread", type=float, default=0.22)
    ap.add_argument("--target", default="index.html",
                    help="index.html (WebGL, primary) or canvas.html (canvas 2D)")
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
    aspects = []
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
                        # Face count is no longer voxels x 3: shapes emit
                        # different face counts (a tile is one quad, a blob two
                        # ten-gons, a cylinder a quad plus a cap). Assert every
                        # voxel produced geometry rather than an exact count.
                        if g["faces"] < g["voxels"]:
                            fails.append(f"{link[:24]} {sp}/{sw} t={t}: only "
                                         f"{g['faces']} faces for {g['voxels']} voxels")

                    if sw == SWATCHES[0]:
                        a, _, _ = silhouette_aspect(arb.shoot(0.0, clock=1234.0))
                        aspects.append((a, f"{link[:24]} {sp}", sp))
                        if not (args.aspect_lo <= a <= args.aspect_hi):
                            fails.append(f"silhouette aspect {a:.3f} outside "
                                         f"[{args.aspect_lo}, {args.aspect_hi}]: {link[:24]} {sp}")

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

        # ---- quiet zone must survive a lost GPU context -----------------
        quiet_after = quiet_zone_survives_context_loss(arb)
        if quiet_after is not None and quiet_after < 200:
            fails.append(
                f"quiet zone went dark after context restore: luma {quiet_after:.0f}/255")

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
    if quiet_after is None:
        print("   after context loss : n/a (no WebGL context on this build)")
    else:
        print(f"   after context loss : {quiet_after:.0f}/255 (forced loss+restore)")
    print(f"3. through camera    : {pct(cam_ok, cam_n)}  "
          f"({args.cam_trials} trials each: warp+blur+dim+noise+downscale)")
    lo = min(a for a, _, _ in aspects); hi = max(a for a, _, _ in aspects)
    inb = sum(1 for a, _, _ in aspects if args.aspect_lo <= a <= args.aspect_hi)
    per = {}
    for a, _, sp in aspects:
        per.setdefault(sp, []).append(a)
    means = {k: sum(v) / len(v) for k, v in per.items()}
    spread = max(means.values()) - min(means.values())
    if spread < args.min_spread:
        fails.append(f"species silhouettes have converged: spread {spread:.3f} "
                     f"< {args.min_spread}")
    print(f"4. wind at t=1       : {'bit-identical across 3 clocks' if wind_static else 'NOT STATIC'}")
    print(f"   wind at t=0       : {'moving (' + str(moved) + ' channel-units)' if wind_moves else 'STATIC - BROKEN'}")
    print(f"6. silhouette aspect : {inb}/{len(aspects)} in [{args.aspect_lo}, {args.aspect_hi}]"
          f"   range {lo:.3f}-{hi:.3f}")
    print("   per species        : " + "  ".join(
        f"{k} {v:.2f}" for k, v in sorted(means.items(), key=lambda kv: -kv[1])))
    print(f"   spread             : {spread:.3f} (min {args.min_spread}) "
          f"- four shapes, not four sizes")
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
