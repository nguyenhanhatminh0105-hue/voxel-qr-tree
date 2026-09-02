"""Simulate a phone camera pointed at the screen.

Perspective warp, defocus blur, dim uneven light, sensor noise, downscale. The
point is to fail the way a real scan fails, not to look pretty.
"""
import cv2
import numpy as np


def simulate(img, rng, strength=1.0):
    h, w = img.shape[:2]
    out = img.astype(np.float32)

    # --- perspective: the phone is never square-on -----------------------
    j = 0.055 * strength
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = np.float32([[rng.uniform(0, j) * w, rng.uniform(0, j) * h],
                      [w - rng.uniform(0, j) * w, rng.uniform(0, j) * h],
                      [w - rng.uniform(0, j) * w, h - rng.uniform(0, j) * h],
                      [rng.uniform(0, j) * w, h - rng.uniform(0, j) * h]])
    M = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(out, M, (w, h), borderMode=cv2.BORDER_REPLICATE)

    # slight roll
    ang = rng.uniform(-4.0, 4.0) * strength
    R = cv2.getRotationMatrix2D((w / 2, h / 2), ang, 1.0)
    out = cv2.warpAffine(out, R, (w, h), borderMode=cv2.BORDER_REPLICATE)

    # --- defocus ---------------------------------------------------------
    k = int(rng.integers(3, 8)) * 2 + 1
    out = cv2.GaussianBlur(out, (k, k), 0)

    # --- dim, uneven illumination ---------------------------------------
    gain = rng.uniform(0.52, 0.78)
    lift = rng.uniform(10, 34)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    vign = 1.0 - 0.30 * strength * (((xx - w / 2) / w) ** 2 + ((yy - h / 2) / h) ** 2) * 4
    out = out * gain * vign[..., None] + lift

    # --- sensor noise ----------------------------------------------------
    out += rng.normal(0, 5.0 * strength, out.shape)

    # --- downscale, as a scanner preview buffer would --------------------
    f = rng.uniform(0.34, 0.50)
    small = cv2.resize(np.clip(out, 0, 255).astype(np.uint8),
                       (max(64, int(w * f)), max(64, int(h * f))),
                       interpolation=cv2.INTER_AREA)
    return small
