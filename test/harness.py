"""Playwright driver: loads the real index.html from file:// and renders it.

Everything downstream works on pixels that a browser actually produced. An
analytic check of module colours would be much faster and completely useless -
it cannot see the slab, canvas antialiasing, sub-module coverage or the
inflation applied to ground tiles, so it would pass while the real render
fails.
"""
import base64
import io
import os

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
def page_url(name="index.html"):
    return "file:///" + os.path.join(ROOT, name).replace("\\", "/")


INDEX = page_url()


class Arboretum:
    def __init__(self, width=760, height=760, dpr=2, reduce_motion=False,
                 target="index.html"):
        self._pw = sync_playwright().start()
        # SwiftShader keeps the WebGL build (the default target) renderable
        # in headless CI.
        self._browser = self._pw.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        self._ctx = self._browser.new_context(
            viewport={"width": width, "height": height + 190},
            device_scale_factor=dpr,
            reduced_motion="reduce" if reduce_motion else "no-preference",
        )
        self.page = self._ctx.new_page()
        self.page.goto(page_url(target))
        self.page.wait_for_function("window.__arb !== undefined")

    def close(self):
        self._ctx.close()
        self._browser.close()
        self._pw.stop()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    # --- driving ------------------------------------------------------
    def set_state(self, text=None, species=None, swatch=None, t=None):
        return self.page.evaluate(
            "o => window.__arb.setState(o)",
            {k: v for k, v in
             dict(text=text, species=species, swatch=swatch, t=t).items() if v is not None},
        )

    def render(self, t, clock=0.0):
        self.page.evaluate("a => window.__arb.renderAt(a[0], a[1])", [t, clock])

    def shoot(self, t, clock=0.0):
        """Render one frame at an explicit clock and return the canvas as RGB.

        The render and the readback happen in ONE evaluate, deliberately. Both
        apps keep a requestAnimationFrame loop running, so splitting these into
        two round trips lets a rAF frame repaint the canvas in between - at the
        wall clock rather than the clock asked for, and with falling petals
        included. That made t=0 silhouette measurements jitter by up to 0.11
        between identical runs. At t=1 it was harmless (wind is zero and petals
        have faded), which is why the decode gates never caught it.
        """
        data = self.page.evaluate(
            """a => { window.__arb.renderAt(a[0], a[1]);
                      return document.getElementById('stage').toDataURL('image/png'); }""",
            [t, clock],
        )
        raw = base64.b64decode(data.split(",", 1)[1])
        return np.array(Image.open(io.BytesIO(raw)).convert("RGB"))

    def faces(self, t, clock=0.0):
        return self.page.evaluate("a => window.__arb.faces(a[0], a[1])", [t, clock])

    def matrix(self):
        return np.array(self.page.evaluate("() => window.__arb.matrix()"), dtype=np.uint8)

    def geom(self):
        return self.page.evaluate("() => window.__arb.geom()")

    def audit(self):
        return self.page.evaluate("() => window.__arb.audit()")


def silhouette_aspect(img, bg=(237, 234, 227), tol=10):
    """Rendered diorama height / plot width, measured on the actual render.

    The bounding box of the diorama: its width is the plot's projected diagonal
    (the widest thing in frame) and its height spans slab rim to crown top. The
    reference video sits at 0.96. A flat canopy drives this down and reads as a
    disc on a plaza; it is the single number that best tracks "does this look
    like the reference".

    Small disconnected blobs are discarded before measuring. Falling petals are
    exactly that, and the WebGL build's test hook draws them while the canvas
    build's does not - without this the two renderers disagree by up to 0.15 on
    an identical scene, and the petals (which drift above the crown) inflate the
    height. Anything under 1% of the largest component's area is not diorama.
    """
    from scipy import ndimage

    d = np.abs(img.astype(np.int16) - np.array(bg, np.int16)).max(axis=2)
    mask = d > tol
    if not mask.any():
        return 0.0, 0, 0
    lab, count = ndimage.label(mask)
    areas = ndimage.sum(mask, lab, range(1, count + 1))
    keep = np.nonzero(areas >= areas.max() * 0.01)[0] + 1
    solid = np.isin(lab, keep)
    ys, xs = np.nonzero(solid)
    h = ys.max() - ys.min() + 1
    w = xs.max() - xs.min() + 1
    return h / w, w, h


def save(img, name):
    os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
    p = os.path.join(ROOT, "out", name)
    Image.fromarray(img).save(p)
    return p
