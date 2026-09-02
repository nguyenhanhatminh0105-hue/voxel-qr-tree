#!/usr/bin/env python3
"""Inline every source file into self-contained HTML.

Both apps have to run from a file:// URL with no network and no dependencies,
so the build is deliberately dumb: substitute each source into its template.
The sources stay separate on disk purely so they can be unit tested under Node.

  index.html  canvas 2D, no dependencies at all
  three.html  same QR / palette / scene code, WebGL rendering, three.js
              vendored inline (built with:
              npx esbuild vendor/three-entry.js --bundle --format=iife --minify)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
VENDOR = os.path.join(HERE, "vendor")

# Shared across both builds: the encoder, the contrast floor and the planting
# rules are renderer-agnostic.
COMMON = {
    "CSS": ("src", "style.css"),
    "QR": ("src", "qr.js"),
    "PALETTE": ("src", "palette.js"),
    "SCENE": ("src", "scene.js"),
}

CANVAS_PARTS = dict(COMMON, RENDER=("src", "render.js"), APP=("src", "app.js"))
THREE_PARTS = dict(COMMON, RENDER=("src", "render.js"),
                   THREE=("vendor", "three.global.js"),
                   THREEAPP=("src", "three-app.js"))

FORBIDDEN = ("<script src", '<link rel="stylesheet"', "@import ", "cdnjs", "unpkg", "jsdelivr")


def read(where, name):
    root = SRC if where == "src" else VENDOR
    with open(os.path.join(root, name), encoding="utf-8") as f:
        return f.read()


def build(template, parts, out_name):
    html = read("src", template)
    for token, (where, filename) in parts.items():
        marker = "/*__%s__*/" % token
        if marker not in html:
            raise SystemExit("missing marker %s in %s" % (marker, template))
        # The UMD wrappers resolve `require` at call time; in the browser there
        # is none, so each module falls through to its global branch untouched.
        html = html.replace(marker, read(where, filename))

    assert "/*__" not in html, "unsubstituted marker left in " + out_name
    # Nothing may be fetched at runtime - the app must work from file://.
    for bad in FORBIDDEN:
        assert bad not in html, "external reference %r in %s" % (bad, out_name)

    out = os.path.join(HERE, out_name)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)
    print("wrote %s  (%.1f KB, no external requests)"
          % (out_name, os.path.getsize(out) / 1024))


def main():
    build("index.template.html", CANVAS_PARTS, "index.html")
    if os.path.exists(os.path.join(VENDOR, "three.global.js")):
        build("three.template.html", THREE_PARTS, "three.html")
    else:
        print("skipping three.html (vendor/three.global.js not built)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
