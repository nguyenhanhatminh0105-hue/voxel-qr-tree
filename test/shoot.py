"""Render preview sheets: each species in tree view and in code view."""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Arboretum, save, ROOT

URL = "https://github.com/nguyenhanhatminh0105-hue"
SPECIES = ["sakura", "oak", "ginkgo", "willow"]


def sheet(images, cols, pad=14, bg=(237, 234, 227)):
    h, w = images[0].shape[:2]
    rows = (len(images) + cols - 1) // cols
    out = np.zeros((rows * h + (rows + 1) * pad, cols * w + (cols + 1) * pad, 3), np.uint8)
    out[:] = bg
    for i, im in enumerate(images):
        r, c = divmod(i, cols)
        y = pad + r * (h + pad)
        x = pad + c * (w + pad)
        out[y:y + h, x:x + w] = im
    return out


def main():
    with Arboretum(width=520, height=520, dpr=2) as arb:
        trees, codes = [], []
        for sp in SPECIES:
            # "auto" = the species' own foliage colour. Passing None would not
            # reset it: set_state drops None keys, so the previous swatch sticks
            # and the sheet meant to show four species shows one colour four times.
            info = arb.set_state(text=URL, species=sp, swatch="auto")
            print(f"{sp:7} v{info['version']} {info['size']}x{info['size']} "
                  f"{info['voxels']} voxels")
            trees.append(arb.shoot(0.0, clock=1200.0))
            codes.append(arb.shoot(1.0, clock=1200.0))
        save(sheet(trees, 4), "preview_trees.png")
        save(sheet(codes, 4), "preview_codes.png")

        # swatch sweep on one species
        sw = []
        for s in ["rose", "jade", "amber", "indigo", "plum", "moss"]:
            arb.set_state(text=URL, species="oak", swatch=s)
            sw.append(arb.shoot(0.0, clock=1200.0))
        save(sheet(sw, 6), "preview_swatches.png")

        # mid-flip
        arb.set_state(text=URL, species="willow", swatch="indigo")
        mid = [arb.shoot(t, clock=1200.0) for t in (0.0, 0.35, 0.65, 1.0)]
        save(sheet(mid, 4), "preview_flip.png")
    print("wrote", os.path.join(ROOT, "out"))


if __name__ == "__main__":
    main()
