# QR Arboretum

Type a URL. It grows into an isometric voxel tree on a square plot. Tap the
plot and the camera swings to straight-down, where the whole diorama reads as a
scannable QR code.

Two builds, same behaviour, same test suite:

| file | renderer | size | frame cost | dependencies |
|---|---|---|---|---|
| **`index.html`** | WebGL, three.js r180 vendored inline, InstancedMesh | 765 KB | 1.3 ms | none at runtime |
| `canvas.html` | canvas 2D, painter's algorithm | 73 KB | 23 ms | none at all |

Both are single files and both run from a `file://` URL with no network access.
Open either directly in a browser. (Frame cost is the worst case over every
species at 25x25 through 37x37 — 4,472 voxels — measured after a warm-up in a
fresh page. The WebGL figure is software-rendered SwiftShader, so a real GPU is
faster still.)

![Four species](docs/trees.png)

Spring sakura, summer oak, autumn gum, winter willow. Tap the plot and each one
flattens into its own code:

![The same four, straight down](docs/codes.png)

![The flip](docs/flip.gif)

The flip in motion — wind and petals at rest, decaying to exactly zero as the
camera swings overhead. Also as video: [`docs/flip.mp4`](docs/flip.mp4)
(one tree) and [`docs/seasons.mp4`](docs/seasons.mp4) (all four).

A single tree at full size — `https://smaran.studio`, silhouette aspect 0.963:

![Sakura](docs/sakura.png)

---

## The trick

Generate the QR matrix first, then plant the scene so that **every voxel above
ground sits on a dark module** — trunk, branches, leaves, grass, all of it.
The straight-down view then reproduces the matrix exactly, whatever shape the
planting takes. Light modules are pale paving; dark modules are dark soil with
things growing out of them.

The rule is cheap to enforce because **darkness is a property of `(x, y)`
only** — it does not vary with height. Two consequences shape everything:

- A vertical column planted on a dark cell is dark at every level. Trunks and
  willow tendrils are never eroded.
- Anything that spreads in x/y — crowns, limbs, foliage — gets carved by the
  matrix. **That carving is the look.**

The ground layer alone already reproduces the matrix. Foliage only ever adds
more dark on top of already-dark cells, so it cannot damage the code.

## Constraints worth keeping

**Cubes may be smaller than their module and offset inside it, but must never
cross the edge.** This is what makes foliage look organic instead of like
stacked crates. Leaves are roughly half-module scale, scattered, several per
column at varied heights. Enforced in exactly one place — `place()` in
`src/scene.js`, the only function that creates a voxel.

**Gaps in foliage are safe.** There is deliberately no rule that foliage must
fill its module — it would turn every crown into a stack of crates. What the
gaps must not show is *bare brown ground*; see the fallen-blossom carpet
below.

But the carving is not what made the canopy read as lace. See below.

**Every dark module is a raised block, never a flat tile.** Flat tiles make
the plot read as ink printed on a floor. Raised blocks make it read as terrain
the tree is growing out of. Grass and soil where the crown does not reach,
fallen blossom where it does.

Height matters more than it sounds. At around a quarter of a module the blocks
still read as flat plates scattered on the slab — the exact failure raising
them was meant to fix. They are 0.52–0.82 of a module, which is enough side
face to register as depth from the isometric view and changes nothing overhead.

**Ground sits near 3.5:1, not the near-black 10:1 you first reach for.** The
ground layer alone reproduces the matrix, so the instinct is to make it as
dark as possible — but the floor is 3:1 and every stop past it is headroom
spent on nothing, at the cost of a floor that competes with the tree.

**Every colour that can land on a dark module needs ≥3:1 contrast against the
paving.** See below; this forces deeper tones than anyone would pick for looks.

**Tonal variation on dark-module surfaces only ever goes darker; variation on
paving only ever goes lighter.** If the two families converge you get an
unscannable code that looks fine on screen.

**Side faces are never seen from overhead**, so they can carry colour the code
could not survive on top. The gum's near-white bark is 1.11:1 against the
paving — unusable on a top face, fine on a side.

**Wind decays to exactly zero in the code view.** Horizontal sway moves leaves
off their modules and destroys the code. Amplitude is scaled by `(1 - t)²`, and
each voxel is *sheared* between its base and its top rather than translated, so
trees bend instead of sliding.

Three details that are easy to get wrong, and were:

- **Phase is per COLUMN, not per voxel.** Hashing `z` into it gave every voxel
  in a stack its own phase, so a trunk's nine bark segments displaced
  independently and the trunk *split at its seams* — two abutting segments at
  +0.193 and −0.018 in the same instant, a 0.21-module tear. It also made the
  canopy boil rather than sway. Phase per column means a column moves as one
  piece and neighbours lag into a wave.
- **Height is normalised by `maxZ`.** Using absolute `z` made displacement grow
  with the tree, so a bigger code got a windier tree: 2.22 modules of crown
  sway at n=25 rising to 3.26 at n=33. As a fraction of tree height it is
  scale-free — 0.500 modules at both.
- **Stiffness is per kind.** Bark and leaf obeying one law made trunks sway
  like saplings. `bark 0.15, leaf 1.0, blade 0.4, ground 0` — the trunk now
  moves 0.009 modules and the ground exactly zero.

The law lives in `scene.js` as a precomputed per-voxel coefficient, so both
renderers obey it instead of each reimplementing `pow(z, 1.4)`.

**A 4-module quiet zone** is reserved as the camera goes overhead, and the
canvas background is flooded with the paving colour so the margin reads light.

### Orthographic camera, and why it is not a tuning knob

The WebGL build uses `OrthographicCamera`. It has to.

The whole trick depends on a voxel at height `h` landing on **its own module**
when seen from above. Under perspective it projects outward by
`r * h / (D - h)`, where `r` is horizontal distance from the view axis and `D`
the camera distance:

| camera distance | voxel at r=8, h=12 | voxel at r=16, h=18 |
|---|---|---|
| 40 | 3.4 modules off | 13.1 modules off |
| 120 | 0.9 modules off | 2.8 modules off |
| 1000 | 0.1 modules off | 0.3 modules off |
| orthographic | **0.00** | **0.00** |

Pushing the camera away makes the error small, never zero, and costs depth
precision on the way.

The isometric view is the same camera at yaw 45 deg and pitch
`atan(1/sqrt(2))` — the true isometric elevation, where all three axes
foreshorten equally — animating to yaw 0, pitch 90.

### Lighting would eat the contrast budget

There are **no lights in the WebGL scene at all**. Materials are
`MeshBasicMaterial` with per-instance colour.

Ordinary 3-D lighting does the exact opposite of what this design needs. A
light from above makes top faces the *brightest* — and the top face is the
only one a scanner sees, so brightening it walks foliage back up through the
3:1 floor and makes the code unscannable while still looking perfectly fine on
screen. Here the top face carries the base tone and the two sides are baked
darker, so every surface is exactly the value the audit checked.

For the same reason the contrast check samples the **framebuffer**, never
`material.color`.

### One InstancedMesh per face

A 33x33 code carries 1,200–1,650 boxes. Each box shows at most three faces —
yaw stays in [0, 45] and pitch in [35, 90], so +x, +y and the underside are
never front-facing — so there are three `InstancedMesh` objects over a
single-quad geometry, one per face orientation, each carrying its own exact
per-instance colour.

Three meshes rather than one is deliberate: `instanceColor` is one colour per
instance, and each box needs three different tones. Splitting by face is what
keeps the colours exact instead of approximating them with a shader multiply
in the wrong colour space.

The wind shear goes straight into the instance matrix — a 4x4 can express it:

```
X = x + u*w + (lo + (hi-lo)*t) * dirX
Y = y + v*d + (lo + (hi-lo)*t) * dirY
Z = z + t*h
```

with `lo` the displacement at the box's base and `hi` at its top. The base
stays planted and the top leans, so the tree bends rather than slides. At
`amp = 0` both are exactly zero and every matrix returns to its authored
value.

### Draw order (canvas build only)

The full-plot slab cannot be depth-sorted against the tiles sitting on it — one
centre-point key gets it wrong and it paints over the back half of the ground.
It is drawn first, outside the sort.

Watch the origin convention: `render.js` gives every box by its **minimum
corner plus extents**, with no implicit half-module shift anywhere. The slab is
therefore exactly `(0,0)` to `(n,n)`. If a `-0.5` shift is ever added to the
drawing code, the slab's own x/y must cancel it or it juts past two edges and
eats the quiet zone.

Flat ground never overlaps anything standing on it, so it is painted wholesale
before the sort — which lets it be cached to an offscreen canvas between
frames. That cache matters, because wind forces a full redraw every frame.

**These are artefacts of painter's-algorithm sorting and simply evaporate in
the WebGL build**, where a depth buffer does the work — the slab is just one
more instance there, there is no ground cache, and back-face culling is the GPU's
job. Only coplanar z-fighting replaces them, handled by the gap between the
slab top and the blocks seated on it.

What does *not* evaporate: the orthographic requirement, the contrast floor,
the edge-crossing rule and the wind decay all survive unchanged.

---

## Why the canopy was see-through (and it was not the carving)

Roughly half the columns get carved away, so it is tempting to blame the
matrix. The carving was innocent. Three defects in the crown fill did it:

**The crown was a flat disc.** At n=25 the sakura had radius 7.35 and
half-height 2.88 — 14.7 wide, 5.8 tall, aspect 0.39. A flat crown has *nothing
behind any gap*, so every hole shows background. Depth along the view axis is
what hides carving: a tall crown stacks rows behind one another and the gaps
fill in. Crowns now run 1.18–1.29.

**Leaf count scaled with footprint, not volume.** `count = density * PI*r*r`
ignored half-height entirely, so raising the crown — the actual fix — spread
the same leaves through more volume and made the lattice *worse*.

**Rejection sampling left vertical holes.** Points were scattered through a
ball and any landing on a light module discarded. Survivors were Poisson
distributed per column, so some dark columns got one leaf and some got none —
and an empty column is a hole you can see straight through.

The fix replaces sampling with a **per-column fill**: walk the dark modules in
the footprint, compute each column's vertical span from the ellipsoid, and
stack leaves up it continuously. A column is then either solid or absent, never
speckled. It is denser for the same leaf budget and throws away none of the
~50% of samples that used to land on paving. Overlapping clouds merge their
spans first, so stacked puffs do not double up.

### Shell fill, at both ends

Filling whole spans makes leaf count scale with crown *volume*, so a version 13
code wanted 45,000 leaves. Each column therefore fills a shell rather than its
whole span: `clamp(0.62 * span, 3.5, 7.5)` modules from the top, plus 0.6x that
from the bottom.

**The bottom half is not optional.** A top-only shell was justified on the
grounds that deeper leaves are occluded by the columns in front of them. That
premise is false at 35° elevation — the columns in front were shelled away too,
so nothing is left to do the occluding and you look straight under the dome and
out the other side. Measured on the sakura at n=25, the crown carried a 6.4
module cap on a 16.9 module span and floated 5.45 modules above the trunk top.

The lower shell is thinner than the upper one because less of the underside is
ever seen. Both scale with span, so the fill still tracks crown *footprint*
rather than volume: 4,024–4,472 voxels at 37x37 instead of 21,046.

## The fallen-blossom carpet

Leaves are smaller than their module. Left alone, the gaps between them show
brown soil from overhead and a crown reads as pink *speckle on dirt* rather
than the solid blossom it should be.

The fix costs no geometry. While planting, every module that ends up with
foliage overhead is recorded — inside the leaf, tendril and limb helpers — and
its ground block is then coloured with fallen blossom instead of soil:

```js
pal.mat.fallen  = darken(canopy, 0.24);
pal.mat.fallen2 = darken(canopy, 0.34);
// per module under the crown, chosen by stable per-cell noise
```

From overhead the module now reads solid: leaf cube where there is a leaf,
fallen petal where there is not, both in the same colour family. From the
isometric view you get the drift of petals on the ground under the tree.

Contrast is unaffected — both fallen tones are *darker* than the leaves above
them, so they clear the floor by more than the foliage does. Soil stays brown
everywhere the crown does not reach.

## Proportion

A crown at 35–40% of the plot width reads as a shrub on a large empty plaza
however good the foliage is. All four species are dimensioned as fractions of
`n`, the matrix size, so a version 2 code and a version 10 code grow trees of
the same proportion. At 33x33:

| species | voxels | of which canopy | height as % of plot width |
|---|---|---|---|
| sakura | 1,642 | 1,095 | 60% |
| oak | 1,541 | 994 | 68% |
| gum | 1,289 | 742 | 57% |
| willow | 1,399 | 852 | 52% |

The sakura is built to an explicit recipe: trunk `n*0.20`, main puff at
`trunkH + n*0.19` with radius `n*0.30*0.98` and half-height `n*0.115`, four
side puffs at `R*0.60` from centre, and one high puff at `trunkH + n*0.31`.
That puts the crown top near `0.51 n`, plus sprigs above it.

## Where the contrast floor overrode taste

Paving is `#EDEAE3` (luminance 0.824). At a 3:1 floor, anything that can land
on a dark module must sit at luminance ≤ 0.241.

Two mistakes are easy here, and this project made both before making neither.

**Overshooting the floor.** Shipping foliage at 5:1 or 8:1 spends headroom on
nothing and makes the whole scene read as dark wine rather than blossom. Every
swatch now sits just above 3.2:1.

**Deriving the colour by darkening a pastel.** Multiplying toward black scales
all three channels together, so chroma collapses along with luminance:
`#F8C8DC` treated that way lands on `#947884`, a grey mauve. Each swatch is
instead a *saturated hue chosen at the target luminance* — fix hue and
saturation, solve lightness for the ratio.

| swatch | shipped | ratio | natural choice | ratio |
|---|---|---|---|---|
| Rose | `#c1647d` | 3.25:1 | `#F8C8DC` | **1.2:1** |
| Jade | `#4b8f5b` | 3.25:1 | `#7BC47F` | **1.7:1** |
| Amber | `#9c7c51` | 3.23:1 | `#F2B441` | **1.5:1** |
| Indigo | `#6182ba` | 3.23:1 | `#8FA8DE` | **2.0:1** |
| Plum | `#ae64c0` | 3.25:1 | `#C79BE0` | **1.9:1** |
| Moss | `#738947` | 3.24:1 | `#AFC46B` | **1.6:1** |

Ground is lightened to match: soil `#90795c` at 3.44:1, grass `#618648` at
3.49:1. A dark floor competes with the tree; the plot should recede as a plaza
rather than read as a second pattern fighting the canopy.

![Six swatches](docs/swatches.png)

Pastel pink is 1.2:1 and will not scan — but 3.2:1 is enough, and the
difference between 3.2:1 and 5.4:1 is the difference between cherry blossom
and dark wine.

One second-order consequence is worth calling out, because it looks like a
style choice and is not. With every top face forced dark, shading the side
faces *lighter* — the obvious move — makes every leaf read as a dark cap on a
pale stalk, and the crown looks like a field of mushrooms. Side faces are
exempt from the floor, so they are shaded **darker** than the tops instead,
which restores ordinary top-lit form for free. The gum keeps light sides,
because its pale bark is the entire point of the species.

That gives the five-tone ladder every dark-module surface is drawn from:

| tone | offset | used for | ratio (rose) |
|---|---|---|---|
| top | 0 | top faces — the only ones a scanner sees | 5.4:1 |
| right | −16% | `-y` side face | 6.9:1 |
| fallen | −24% | ground under the crown | 7.8:1 |
| left | −32% | `-x` side face | 8.8:1 |
| fallen2 | −34% | ground under the crown, alternate | 9.0:1 |

Every rung is darker than the top, so the top face is the binding constraint
and everything else clears the floor by construction.

---

## The QR encoder

Written from scratch: byte mode, versions 1–20, ECC L/M/Q/H. `src/qr.js`, no
dependencies, runs in the browser and under Node.

Two traps that cost real time:

**The Reed–Solomon generator polynomial is easy to build with its coefficients
reversed.** It is symmetric at degree 1 — the answer is the single element
`[1]` either way — so it looks correct until degree 2, where the right answer
is `[3, 2]` and the reversed one is `[2, 3]`. `rsGeneratorSelfTest()` pins that
case down and the harness asserts it.

**Penalty rule 3** (the 1:1:3:1:1 finder lookalike) must scan
**non-overlapping**, and must treat modules outside the symbol as **light**.
Both halves matter. Drop the virtual border and edge-hugging lookalikes go
unpenalised; let the scan window overlap and one dark core gets scored
repeatedly. Either way mask selection drifts toward codes real scanners
struggle with.

### Cross-check against segno

```
Reed-Solomon generator polynomial
  degree 1 -> [1]        (symmetric: reversal is invisible here)
  degree 2 -> [3, 2]     (must be [3, 2]; reversed would be [2, 3])
  degree 7 -> [127, 122, 154, 164, 11, 68, 117]
  OK - not reversed

Forced-mask comparison (encoder correctness, segno padding emulated)
  identical to segno : 592
  genuine mismatches : 0
  versions exercised : 1..17

Free-mask comparison (mask selection)
  same mask as segno : 74/74 (100%)  -- differences are legal
```

Two notes on the comparison:

**segno's padding quirk is systematic, not occasional.** `write_padding_bits()`
computes `8 - (length % 8)`, which yields 8 — a whole spurious zero byte — when
the stream is already byte-aligned. In byte mode the stream is
`4 + count + 8n` bits, which after a full 4-bit terminator is *always*
aligned, so segno inserts that byte on **every** byte-mode symbol. The
comparison runs with an opt-in `padQuirk` flag that reproduces it, which
isolates the difference to exactly that byte and proves everything else — bit
stream, RS codewords, interleaving, module placement, masking, format and
version info — is identical.

**Non-ASCII needs `encoding="utf-8"` on the segno side.** segno defaults byte
mode to ISO-8859-1 when the text fits; we always emit UTF-8.

Masks may also differ legitimately, since segno scores before writing format
info. In practice they agreed on all 74 cases here.

---

## Verification

```
python build.py                                   # produce index.html + canvas.html
python test/test_qr_vs_segno.py                   # encoder vs segno
python test/test_qr_decode.py                     # shipped matrices, ZBar
python test/test_render.py                        # WebGL, full sweep
python test/test_render.py --target canvas.html   # canvas 2D, full sweep
python test/shoot.py                              # preview sheets into out/
python test/record.py --gif                       # docs/flip.mp4 + flip.gif
python test/record.py --seasons --out docs/seasons.mp4
```

**Do not trust `cv2.QRCodeDetector`** (the legacy OpenCV one). It fails on
perfectly valid codes and will send you chasing bugs that do not exist. The
gate here is **pyzbar** (ZBar, the engine behind many real scanner apps), with
`cv2.QRCodeDetectorAruco` as a second opinion.

The harness rasterises the **actual render** through a real headless browser
and decodes those pixels. It does not check module colours analytically — that
version cannot see the slab, antialiasing, the half-pixel tile inflation, or a
voxel overhanging its module, and it would pass while the real thing fails.

### Results

`index.html` (WebGL), 6 links × 4 seasons × 6 swatches:

```
combinations swept   : 144
geometry checks      : 288 (no malformed faces)

1. ZBar, clean       : 144/144 (100.0%)
   cv2 Aruco         : 144/144 (100.0%)   [second opinion]
2. matrix from pixels: 144/144 (100.0%) exact, 0 modules differ
   quiet zone min lum: 234/255 (paving ~234; must stay light)
3. through camera    : 432/432 (100.0%)  (warp+blur+dim+noise+downscale)
4. wind at t=1       : bit-identical across 3 clocks
   wind at t=0       : moving
6. silhouette aspect : 24/24 in [0.90, 1.05]  range 0.908-1.042  (video 0.96)
```

`canvas.html` scores identically on the same sweep, including the silhouette
range to three decimal places — the two renderers share `qr.js`, `palette.js`
and `scene.js` verbatim, so agreement there is a check that the metric measures
the planting rather than the renderer.

The checks are:

1. **Decode clean.** ZBar on the code-view render.
2. **Matrix from pixels.** Reconstruct the matrix by sampling rendered pixels
   and diff it against the true matrix. Must differ by zero modules.
3. **Camera simulation.** Perspective warp, roll, defocus, dim uneven light,
   sensor noise, downscale to ~40%.
4. **Wind.** Bit-identical at `t=1` across different clock times, and genuinely
   moving at `t=0`.
5. **Geometry sweep.** Every link × season × swatch, at both ends of the flip,
   checked for non-finite coordinates, zero-area faces, zero-extent voxels,
   voxels crossing a module edge, voxels on a light module, and missing faces.
6. **Silhouette aspect.** Rendered diorama height ÷ plot width at `t=0`, which
   must land in 0.90–1.05; the reference sits at 0.96. `stats.heightFraction`
   is deliberately *not* used — it includes the fallen carpet, so it reads
   healthy while the crown is a flat disc. There is a separate crown-only
   `crownAspect` in `stats` for the same reason.

   Tuning this against a handful of links is not enough. The matrix decides
   which columns near the crown apex survive carving, so the measurement varies
   by payload — the gum spread 0.136 across links, most of the band, and the one
   case that failed was a link absent from the tuning set. Where a species'
   apex was set by randomly placed clumps, one clump is now anchored on the
   trunk column, which is dark by construction; that pins the top and cut the
   spread to 0.102.

Recordings are driven through `renderAt(t, clock)` with a fixed clock step
rather than screen captured, so they are deterministic and the wind animates at
the intended rate however slowly the capture runs. 31% of the frames in each
clip still decode after h.264 compression — that is the share sitting at or
near `t=1`.

### A measurement bug worth naming

The silhouette metric jittered by up to 0.11 between identical runs, and the
two renderers disagreed by 0.15 on the same scene. Neither was the scene.

`shoot()` was doing `renderAt` and `toDataURL` as two separate round trips, and
both apps keep a `requestAnimationFrame` loop running — so a frame could
repaint the canvas in between, at the wall clock rather than the clock asked
for, and *with falling petals*. The capture is now a single evaluate.

The renderer disagreement had a second cause: the WebGL test hook draws petals
and the canvas one does not. The metric now discards connected components under
1% of the largest, which is what petals are. After both fixes the two builds
agree to **0.0000** on every case — which is itself a decent check that the
metric measures the shared planting rather than the renderer.

This is the same shape of problem as the mirrored render: every decode gate was
green throughout, because at `t=1` the wind is zero and petals have faded, so
the race was invisible to them.

### Bugs this found

- **Block interleave was missing the short-block placeholder.** Short blocks
  must be stored at the long-block length with a placeholder in their last data
  slot. Without it the ECC section starts one index early and the interleave
  skip lands on a real error-correction codeword — the entire ECC run comes out
  shifted by one and the symbol is quietly corrupt.
- **The WebGL build rendered the whole plot mirrored left-to-right.**
  `render.js` projects with x right, y *down* and z toward the viewer, which is
  a left-handed frame; three.js is right-handed. **ZBar decodes mirrored QR
  codes perfectly happily**, so this passed the decode gate at 24/24 and was
  caught only by the pixel-level matrix diff, which reported 468 differing
  modules and `fliplr == True`. Fixed by negating Y when writing instance
  matrices and building the camera basis in that space.

  This is the single best argument for reconstructing the matrix from pixels
  rather than trusting a decoder. Every decode oracle said the render was
  fine. It was not.

---

## Layout

```
src/qr.js            QR encoder, no dependencies
src/palette.js       colour, the contrast floor, the five-tone ladder
src/scene.js         planting: four species, ground blocks, fallen carpet
src/render.js        canvas 2D axonometric renderer
src/app.js           canvas build UI
src/three-app.js     WebGL build (reuses qr/palette/scene untouched)
build.py             inlines everything into index.html / canvas.html
test/                verification harness
vendor/              three.js, bundled to a single global with esbuild
```

`src/` exists so the modules can be unit-tested under Node; the shipped
artefacts are the two HTML files, and `build.py` asserts no external reference
survives into either.

`qr.js`, `palette.js` and `scene.js` are shared verbatim between the two
builds. Everything the code depends on — the matrix, the contrast floor, the
planting rules — is renderer-agnostic, which is also why one test harness can
drive both through the same `window.__arb` hooks.

## Licence

MIT. Bundled three.js is MIT, © three.js authors.
