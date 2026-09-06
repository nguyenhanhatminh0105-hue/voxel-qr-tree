"""Record the diorama animating: idle wind, the flip to the code, and back.

Frames are driven through window.__arb.renderAt(t, clock) rather than screen
captured, so the result is deterministic and reproducible - the same command
produces the same file. The clock is advanced by a fixed step per frame, which
also means the wind and the falling petals animate at exactly the intended
rate regardless of how slow the capture itself is.
"""
import argparse
import os
import sys

import imageio.v2 as imageio
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import Arboretum, ROOT


def ease(t):
    return 4 * t * t * t if t < 0.5 else 1 - pow(-2 * t + 2, 3) / 2


def timeline(fps, flip_ms=950):
    """(t, clock) per frame: settle, flip, hold, flip back, settle."""
    step = 1000.0 / fps
    flip_frames = max(2, round(flip_ms / step))
    seq = []
    clock = 0.0
    def hold(t, frames):
        nonlocal clock
        for _ in range(frames):
            seq.append((t, clock)); clock += step
    def sweep(a, b, frames):
        nonlocal clock
        for i in range(frames):
            seq.append((a + (b - a) * (i + 1) / frames, clock)); clock += step
    hold(0.0, int(fps * 1.6))          # idle: wind and petals
    sweep(0.0, 1.0, flip_frames)       # flip to the code
    hold(1.0, int(fps * 1.4))          # hold the scannable view
    sweep(1.0, 0.0, flip_frames)       # and back
    hold(0.0, int(fps * 0.8))
    return seq


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://smaran.studio")
    ap.add_argument("--species", default="sakura")
    ap.add_argument("--swatch", default="rose")
    ap.add_argument("--target", default="index.html")
    ap.add_argument("--size", type=int, default=640)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--out", default="docs/flip.mp4")
    ap.add_argument("--gif", action="store_true", help="also write an animated GIF")
    ap.add_argument("--seasons", action="store_true",
                    help="cycle all four species instead of recording one")
    args = ap.parse_args()

    frames = []
    with Arboretum(width=args.size, height=args.size, dpr=1, target=args.target) as arb:
        if args.seasons:
            plan = [("sakura", "rose"), ("oak", "moss"),
                    ("gum", "amber"), ("willow", "indigo")]
            seq = timeline(args.fps)
            for sp, sw in plan:
                info = arb.set_state(text=args.url, species=sp, swatch=sw)
                for t, clock in seq:
                    frames.append(arb.shoot(t, clock))
        else:
            seq = timeline(args.fps)
            info = arb.set_state(text=args.url, species=args.species, swatch=args.swatch)
            for t, clock in seq:
                frames.append(arb.shoot(t, clock))
    h, w = frames[0].shape[:2]
    # h.264 needs even dimensions
    if w % 2 or h % 2:
        frames = [f[: h - h % 2, : w - w % 2] for f in frames]

    out = os.path.join(ROOT, args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    imageio.mimwrite(out, frames, fps=args.fps, codec="libx264",
                     quality=8, macro_block_size=None)
    print(f"  {args.out}  {len(frames)} frames @ {args.fps}fps  "
          f"{frames[0].shape[1]}x{frames[0].shape[0]}  "
          f"{os.path.getsize(out) / 1024:.0f} KB")

    if args.gif:
        gif = os.path.splitext(out)[0] + ".gif"
        small = [f[::2, ::2] for f in frames[::2]]
        imageio.mimwrite(gif, small, duration=2 / args.fps, loop=0)
        print(f"  {os.path.relpath(gif, ROOT)}  {len(small)} frames  "
              f"{os.path.getsize(gif) / 1024:.0f} KB")
    print(f"  payload: {args.url}  v{info['version']} {info['size']}x{info['size']}  "
          f"{info['stats']['total']} voxels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
