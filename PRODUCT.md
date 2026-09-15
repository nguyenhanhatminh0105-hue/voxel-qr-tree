# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Engineers and designers reading the repository or opening the live page, plus
people evaluating the author's work. They arrive to look, not to complete a
task: the first question they are answering is "is this real, and does it
actually scan?"

A secondary path exists and must keep working — a visitor types their own URL,
flips the plot, and scans it with a phone or exports the PNG — but the artifact
is the deliverable, not the utility.

## Product Purpose

Type a URL. It grows into an isometric voxel tree on a square plot. Tap the
plot and the camera swings to straight-down, where the whole diorama resolves
into a scannable QR (Quick Response) code.

Success is a visitor who reaches for their phone to test whether the tree is
genuinely a working code, and finds that it is.

## Positioning

The code is not printed on the ground and decorated around. **Every voxel above
ground sits on a dark module** — trunk, branches, foliage, grass, all of it — so
the plan view reproduces the matrix exactly, whatever shape the planting takes.
Darkness is a property of `(x, y)` alone and never varies with height, which is
what makes the rule cheap to enforce and the carving of the crown by the matrix
the defining visual signature.

Two renderers of the same scene, held at test parity, is part of the claim: the
planting rules are renderer-agnostic and provably so.

## Operating Context

**Delivered as a published web page, online only.** A served URL is the only
supported delivery path; opening the file locally is no longer a requirement.

Note the history, because it explains the architecture: `file://` support was
the original constraint and is why both builds are single self-contained files
with nothing fetched at runtime. That property is kept — see Zero dependencies
below — but it is now a design choice rather than a delivery requirement.

Two shipped artifacts, both single self-contained HTML files:

- `index.html` — primary. WebGL, three.js vendored inline.
- `canvas.html` — canvas 2D, painter's algorithm, no dependencies at all.

Verification is a Playwright sweep over 6 links x 4 species x 6 swatches per
build, decoding rendered pixels with ZBar and cv2 Aruco, reconstructing the
matrix from the render and diffing it against truth, and simulating a phone
camera. Design changes are expected to survive that sweep, not to be judged by
eye alone.

## Capabilities and Constraints

Four species (sakura, oak, ginkgo, willow), six foliage swatches, a URL field,
flip-to-code, and PNG export. State rides in the URL hash so a particular tree
can be shared, bookmarked and restored.

**Constraints that are correctness, not taste. These are measured, and a design
pass that changes them produces a code that looks fine on screen and does not
scan:**

- `--paving: #edeae3` is the QR quiet zone, measured at ~234/255 luminance. The
  WebGL renderer clears to the same value from `Palette.PAVING`. It never
  follows the theme; a dark quiet zone is an unscannable one.
- `MIN_RATIO` 2.45:1 is the floor for a dark module's area-weighted **mean**,
  not for each surface. `SOLID_MIN` 3.0:1 governs whole-module single-tone
  surfaces. `TONE_FLOOR` 1.75:1 caps how light any single rung may go.
- Variation on dark-module surfaces only ever goes darker; variation on paving
  only ever goes lighter. If the two families converge the code dies quietly.
- The camera is orthographic. Under perspective a voxel at height `h` projects
  off its own module and the trick fails.
- Wind decays to exactly zero in the code view.

**Constraints the user has made binding:**

- **Zero dependencies.** No CDN, no npm at runtime, no network-fetched fonts.
  Both builds stay single self-contained files.
- **No runtime network calls.** Nothing is fetched while the page runs: no
  CDN, no remote fonts, no analytics, no telemetry. The page is fully painted
  from bytes the server already sent. (This supersedes an earlier "must work
  fully offline" reading; delivery is online only, but the page still reaches
  for nothing once loaded.)
- **Both builds stay at parity.** `canvas.html` must keep matching `index.html`
  on the same sweep, so any UI change lands in both.
- **Security.** Nothing executes or renders visitor input as markup. The URL
  hash is treated as untrusted: unknown species and swatches fall back to
  defaults rather than reaching code that throws on them.
- **No trace of AI assistance** anywhere in the repository, the shipped
  artifacts, commit messages, or author metadata. Verified clean.

## Brand Commitments

Name: QR Arboretum. Licence MIT; bundled three.js is MIT.

Voice in the README is first-person-plural-free, plain, and evidence-led: it
states what was measured, names the bugs that were shipped and how they were
caught, and avoids claims it cannot back with a number. Future writing should
match that register rather than marketing copy.

## Evidence on Hand

Committed preview sheets in `docs/` (four species in tree and code view, the
swatch sweep, the flip), two recorded videos, and a full verification sweep
whose output is quoted verbatim in the README.

## Open Decisions

- No deploy target is configured. Delivery is online only, so this is now
  required rather than optional. GitHub Pages serves these two files as-is with
  nothing to build server-side; no custom domain has been chosen.
- No favicon, no Open Graph or Twitter card metadata, and no canonical URL. A
  shared link currently previews as bare text, which for a portfolio artifact
  whose entire appeal is visual is the most costly gap on this list.
