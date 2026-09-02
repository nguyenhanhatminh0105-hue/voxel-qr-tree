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
        """Render one frame and return the canvas backing store as RGB."""
        self.render(t, clock)
        data = self.page.evaluate(
            "() => document.getElementById('stage').toDataURL('image/png')")
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


def save(img, name):
    os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
    p = os.path.join(ROOT, "out", name)
    Image.fromarray(img).save(p)
    return p
