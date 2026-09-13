/* ===========================================================================
   scene.js - planting. Turns a QR matrix into a list of voxels.

   THE CENTRAL RULE: every voxel above ground sits on a dark module. Nothing
   else about the planting matters to the code, because darkness is a property
   of (x, y) only - it does not vary with height. Two consequences shape all
   four species:

     - A vertical column planted on a dark cell is dark at every level, so
       trunks and willow tendrils are never eroded.
     - Anything that spreads in x/y - crowns, limbs, foliage - gets carved by
       the matrix. That carving IS the look. Do not "repair" it.

   Gaps in foliage are safe. A rule forcing foliage to fill its module would
   turn every crown into a stack of crates. What the gaps must NOT show is
   bare brown ground: see the fallen-blossom carpet in groundBlocks() below.

   Every dark module becomes a RAISED block, never a flat tile. Flat tiles
   make the plot read as ink printed on a floor; raised blocks make it read as
   terrain the tree is growing out of.

   A cube may be smaller than its module and offset within it, but must never
   cross the edge - see place(), which is the only way voxels are created.

   Dimensions are fractions of n, the matrix size, so a version 2 code and a
   version 10 code grow trees of the same proportion.
   =========================================================================== */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./palette.js') : root.Palette
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Scene = api;
})(typeof self !== 'undefined' ? self : this, function (Palette) {
  'use strict';

  // --- deterministic randomness -----------------------------------------
  // Same URL + species + swatch always grows the same tree.
  function hashString(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Wind phase, hashed from the COLUMN - deliberately not from z.

     Including z gave every voxel in a vertical stack its own phase, so the
     nine bark voxels of a trunk displaced independently and the trunk split at
     its seams instead of bending: two abutting segments could sit at +0.193
     and -0.018 at the same instant, a 0.21-module tear. The same defect made
     the canopy boil rather than sway, because every leaf ran on its own clock.

     Phase per column means a column moves as one piece and neighbouring
     columns lag into a wave, which is what reads as wind. */
  function phaseAt(x, y) {
    var h = Math.imul(((x * 73856093) ^ (y * 19349663)) >>> 0, 2654435761) >>> 0;
    return (h / 4294967296) * Math.PI * 2;
  }

  /* Tone hash for dappling. Deliberately hashed on the VOXEL - position and
     height - not the column. Wind phase wants a whole column to move together;
     dappling wants the opposite, neighbours differing, so a crown reads as a
     mass of foliage rather than a grid of identical bricks. Pure position, so
     it never consumes the random stream and stays stable across rebuilds. */
  function toneHash(x, y, z) {
    var h = ((x * 2654435761) ^ (y * 40503) ^ (z * 3266489917)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    return (h >>> 8) / 16777216;
  }

  function pickRung(ladder, r) {
    var acc = 0;
    for (var i = 0; i < ladder.length; i++) {
      acc += ladder[i].w;
      if (r < acc) return ladder[i];
    }
    return ladder[ladder.length - 1];
  }

  // Stable per-module noise, for picking between tones without consuming the
  // random sequence (so tone choice does not shift when density changes).
  function cellNoise(x, y) {
    var h = Math.imul(((x * 374761393) ^ (y * 668265263)) >>> 0, 1274126177) >>> 0;
    return (h >>> 8) / 16777216;
  }

  // The slab spans SLAB_BOTTOM..SLAB_TOP; ground blocks are seated on its top
  // face so no sliver of paving shows beneath them. Their bottom face is never
  // drawn, so being coplanar with the slab top cannot z-fight.
  var SLAB_BOTTOM = -1.5, SLAB_TOP = -0.02;

  /* Per-kind wind stiffness. Bark and leaf obeying the same law made trunks
     sway like saplings; a trunk should barely move while its foliage does. */
  var STIFFNESS = {
    bark: 0.15, leaf: 1.0, tendril: 1.0, blade: 0.4, grass: 0.4, ground: 0
  };

  /* Vertical depth of canopy actually filled per column. A flat minimum plus
     a fraction of the span: rim columns (short spans) fill completely, while
     interior columns keep a proportional body rather than a thin lid, which is
     what stopped the crown reading as a hanging curtain. Capped so very large
     codes stay affordable. */
  var SHELL_MIN = 4.2, SHELL_FRAC = 0.70, SHELL_MAX = 9.0;
  /* The crown needs an underside too. Filling only downward from the top left
     each column a cap on a much longer span - a hollow dome with nothing
     beneath it, which is why the crown looked unmoored from the plot.

     The defence for a top-only shell was that deeper leaves are occluded by
     the columns in front. That premise is false at 35 degrees elevation: the
     columns in front were shelled away as well, so nothing is left to do the
     occluding and you look straight under the dome and out the other side.

     The lower shell is thinner than the upper one because less of the
     underside is ever seen. Both scale with span, so the fill still tracks
     crown FOOTPRINT rather than volume and the 45,000-leaf case stays gone.

     This ratio is also the cheapest lever on voxel count: you see far less of
     the underside than the top, so thinning it costs little visually. */
  var SHELL_LOWER = 0.58;

  var SPECIES = [
    { id: 'sakura', season: 'Spring', name: 'Sakura', fall: 'petals' },
    { id: 'oak', season: 'Summer', name: 'Oak', fall: 'seeds' },
    { id: 'ginkgo', season: 'Autumn', name: 'Ginkgo', fall: 'leaves' },
    { id: 'willow', season: 'Winter', name: 'Willow', fall: 'snow' }
  ];

  /* --- the one voxel constructor ----------------------------------------
     Places a box inside module (mx, my). `size` is the plan footprint as a
     fraction of a module; the offset is chosen so the box is strictly inside
     its module. Crossing a module edge would put dark pixels over a paving
     module and corrupt the code, so the clamp here is load-bearing, not
     defensive tidiness. */
  function place(out, mx, my, z, size, height, mat, kind, rnd) {
    size = Math.max(0.06, Math.min(1, size));
    var slack = 1 - size;
    /* Bark is centred, never jittered. place()'s positional jitter is right
       for foliage and wrong for a trunk: applied to nine stacked bark
       segments it made the trunk centre wander 0.26 modules in x and 0.35 in
       y, a visible zig-zag. A trunk is one axis, top to bottom. */
    /* Bark and blades are centred, never jittered. Bark because a trunk is
       one axis top to bottom. Blades because a tuft splays from a common
       root - and because centring is what makes the splay clamp exact: from
       the centre there is (1 - size)/2 of room on every side, so a lean
       within that can never carry the tip over a module edge. */
    var centred = kind === 'bark';
    var ox = slack > 0 ? (centred ? slack / 2 : rnd() * slack) : 0;
    var oy = slack > 0 ? (centred ? slack / 2 : rnd() * slack) : 0;
    // Dapple: pick a rung of the material's tone ladder from the voxel's own
    // position, so adjacent voxels differ. See toneHash.
    var tone = mat.ladder
      ? pickRung(mat.ladder, toneHash(mx, my, Math.round(z * 16)))
      : mat;
    out.push({
      x: mx + ox, y: my + oy, z: z,
      w: size, d: size, h: height,
      top: tone.top, side: tone.sideA, sideA: tone.sideA, sideB: tone.sideB,
      kind: kind,
      shape: SHAPE[kind] || 'box',
      // static splay, in modules, applied at the top like the wind shear
      leanX: 0, leanY: 0,
      phase: phaseAt(mx, my)
    });
  }

  /* Nothing in the reference is a cube. Voxels carry a shape so each renderer
     can draw the right solid: a tapered cylinder for bark, a rounded blob for
     blossom, a splayed spike for a grass blade, and a flat quad for ground.
     The code invariant is unchanged - it is about what a module looks like
     from directly overhead, not about anything being a box. */
  var SHAPE = {
    bark: 'cyl', leaf: 'blob', tendril: 'blob',
    blade: 'blade', ground: 'tile', grass: 'tile'
  };

  // --- helpers -----------------------------------------------------------
  function makeDark(matrix) {
    var n = matrix.length;
    return function (mx, my) {
      return mx >= 0 && my >= 0 && mx < n && my < n && matrix[my][mx];
    };
  }

  // The dark cell nearest a target, so trunks land on solid ground.
  function nearestDark(matrix, tx, ty) {
    var n = matrix.length, best = null, bestD = Infinity;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!matrix[y][x]) continue;
        var d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
        if (d < bestD) { bestD = d; best = [x, y]; }
      }
    }
    return best || [Math.floor(n / 2), Math.floor(n / 2)];
  }

  /* A planting context. `claimed` records every module that ends up with
     foliage overhead; groundBlocks() later carpets those with fallen blossom
     instead of leaving them bare soil. */
  function Ctx(matrix, pal, rnd, species) {
    this.species = species;
    this.matrix = matrix;
    this.n = matrix.length;
    this.pal = pal;
    this.rnd = rnd;
    this.isDark = makeDark(matrix);
    this.out = [];
    this.spans = {};
    this.crownZ = {};        // per module: [lowest leaf z, highest leaf z]
    this.crownTop = -Infinity;
    this.crownBottom = Infinity;
    this.claimed = [];
    for (var i = 0; i < this.n; i++) this.claimed.push(new Array(this.n).fill(false));
  }

  Ctx.prototype.claim = function (mx, my) {
    if (mx >= 0 && my >= 0 && mx < this.n && my < this.n) this.claimed[my][mx] = true;
  };

  /* --- canopy -----------------------------------------------------------

     Crowns are built in two phases: each cloud RECORDS a vertical span per
     column, then growCanopy() fills every column once. Three reasons.

     1. COLUMNS, NOT SAMPLES. The old version scattered points through a ball
        and discarded any landing on a light module. Survivors were Poisson
        distributed per column, so some dark columns got one leaf and some got
        none - and an empty column is a hole you can see straight through. That
        speckle, not the matrix carving, is what made the canopy read as lace.
        A column filled continuously is either solid or absent, never speckled.
        It also stops throwing away the ~50% of samples that landed on paving.

     2. VOLUME, NOT FOOTPRINT. Leaf count used to scale with PI*r*r and ignore
        halfH entirely, so making a crown taller - which is the actual fix for
        see-through foliage - spread the same leaves through more volume and
        made the lattice worse. Filling by column makes count track volume
        automatically, so height and density stop fighting each other.

     3. OVERLAPPING CLOUDS DON'T DOUBLE UP. Species stack several clouds; where
        they overlap, per-cloud filling would stack two sets of leaves in the
        same column. Merging spans first means one pass, one stack.

     The carving is untouched: light modules still produce nothing. What changes
     is that surviving columns are opaque, and a crown with real depth along the
     view axis puts foliage behind every gap. */
  Ctx.prototype.addSpan = function (mx, my, zBot, zTop) {
    if (!this.isDark(mx, my)) return;
    if (zTop - zBot < 0.15) return;
    this.claim(mx, my);
    var k = my * this.n + mx;
    (this.spans[k] || (this.spans[k] = [])).push([zBot, zTop]);
  };

  /* Record one ellipsoid. `lowBound` is -1 for a full ellipsoid or 0 for a
     dome (upper half only). */
  Ctx.prototype.cloud = function (cx, cy, cz, r, halfH, lowBound) {
    if (lowBound === undefined) lowBound = -1;
    var x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
    var y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
    for (var my = y0; my <= y1; my++) {
      for (var mx = x0; mx <= x1; mx++) {
        var dx = (mx + 0.5 - cx) / r, dy = (my + 0.5 - cy) / r;
        var q = dx * dx + dy * dy;
        if (q >= 1) continue;
        var span = halfH * Math.sqrt(1 - q);   // ellipsoid half-extent here
        this.addSpan(mx, my, cz + lowBound * span, cz + span);
      }
    }
  };

  /* A cluster of small clouds rather than one big ellipsoid. One cloud reads
     as a ball; several overlapping at jittered offsets read as foliage. The
     core is drawn first and is deliberately large enough to keep the interior
     continuous - canopy only materialises over dark modules, so a lobe pushed
     out on its own can land over a light region and leave a bite out of the
     crown. The core is what stops that. */
  Ctx.prototype.clump = function (cx, cy, cz, r, halfH, count, lowBound) {
    var rnd = this.rnd;
    this.cloud(cx, cy, cz, r * 0.80, halfH * 0.94, lowBound);
    for (var i = 0; i < count; i++) {
      var a = rnd() * Math.PI * 2;
      var d = r * (0.26 + rnd() * 0.40);
      this.cloud(cx + Math.cos(a) * d, cy + Math.sin(a) * d,
                 cz + halfH * (rnd() - 0.5) * 0.70,
                 r * (0.40 + rnd() * 0.26), halfH * (0.54 + rnd() * 0.32), lowBound);
    }
  };

  Ctx.prototype.dome = function (cx, cy, cz, r, halfH) {
    this.cloud(cx, cy, cz, r, halfH, 0);
  };

  // One continuous run of leaves up a column between two heights.
  Ctx.prototype.stack = function (mx, my, z, zTop, pack, sizeLo, sizeHi) {
    var rnd = this.rnd;
    var k = my * this.n + mx;
    var cz = this.crownZ[k] || (this.crownZ[k] = [Infinity, -Infinity]);
    if (z < cz[0]) cz[0] = z;
    if (zTop > cz[1]) cz[1] = zTop;
    while (z < zTop) {
      var size = sizeLo + rnd() * (sizeHi - sizeLo);
      var h = size * (0.95 + rnd() * 0.6);
      place(this.out, mx, my, z, size, h, this.pal.mat.leaf, 'leaf', rnd);
      z += h * pack;
    }
  };

  /* Merge each column's spans and stack leaves up them continuously.
     `pack` is the vertical advance as a fraction of leaf height: below 1 the
     stack overlaps, which is what makes a column opaque. */
  Ctx.prototype.growCanopy = function (pack, sizeLo, sizeHi) {
    var rnd = this.rnd, n = this.n;
    var keys = Object.keys(this.spans).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], mx = k % n, my = (k - mx) / n;
      var iv = this.spans[k].slice().sort(function (a, b) { return a[0] - b[0]; });
      var merged = [], cur = iv[0].slice();
      for (var j = 1; j < iv.length; j++) {
        if (iv[j][0] <= cur[1]) cur[1] = Math.max(cur[1], iv[j][1]);
        else { merged.push(cur); cur = iv[j].slice(); }
      }
      merged.push(cur);
      for (var m = 0; m < merged.length; m++) {
        var zBot = merged[m][0], zTop = merged[m][1];
        if (zBot < this.crownBottom) this.crownBottom = zBot;
        if (zTop > this.crownTop) this.crownTop = zTop;
        /* Fill a shell at each end of the span, not the whole span, and not
           only the top - see SHELL_LOWER. */
        var span = zTop - zBot;
        var upper = Math.min(SHELL_MAX, Math.max(SHELL_MIN, span * SHELL_FRAC));
        var topStart = Math.max(zBot, zTop - upper);
        this.stack(mx, my, topStart, zTop, pack, sizeLo, sizeHi);
        if (topStart > zBot) {
          var botEnd = Math.min(topStart, zBot + upper * SHELL_LOWER);
          if (botEnd > zBot) this.stack(mx, my, zBot, botEnd, pack, sizeLo, sizeHi);
        }
      }
    }
  };

  Ctx.prototype.trunk = function (mx, my, z0, height, width) {
    if (!this.isDark(mx, my)) return false;
    // One column on a dark cell is dark at every height, so the trunk is
    // always whole. Segmented so the wind shear reads along its length.
    var seg = Math.max(0.6, height / 9);
    for (var z = z0; z < z0 + height - 1e-6; z += seg) {
      var h = Math.min(seg, z0 + height - z);
      var size = width * (1 - 0.12 * (z - z0) / Math.max(1, height));
      place(this.out, mx, my, z, size, h, this.pal.mat.bark, 'bark', this.rnd);
    }
    return true;
  };

  Ctx.prototype.limb = function (cx, cy, ang, len, z0, rise, w0) {
    var steps = Math.max(3, Math.round(len * 1.8));
    for (var k = 1; k <= steps; k++) {
      var f = k / steps;
      var mx = Math.floor(cx + Math.cos(ang) * len * f);
      var my = Math.floor(cy + Math.sin(ang) * len * f);
      if (!this.isDark(mx, my)) continue;
      this.claim(mx, my);                       // limbs shade the ground too
      place(this.out, mx, my, z0 + f * rise, w0 * (1 - 0.3 * f), 0.6,
        this.pal.mat.bark, 'bark', this.rnd);
    }
  };

  /* Willow tendril: narrow in plan, continuous in z. A scatter of cubes here
     reads as a bush, not a hanging branch, so this is its own primitive - a
     few tall jointed segments, each staying inside its module. */
  Ctx.prototype.tendril = function (mx, my, zTop, length) {
    if (!this.isDark(mx, my)) return;
    this.claim(mx, my);
    var rnd = this.rnd;
    var joints = 2 + Math.floor(rnd() * 3);
    var remaining = length, z = zTop;
    for (var j = 0; j < joints && remaining > 0.3; j++) {
      var segLen = j === joints - 1 ? remaining : remaining * (0.35 + rnd() * 0.4);
      segLen = Math.min(segLen, remaining);
      place(this.out, mx, my, z - segLen, 0.13 + rnd() * 0.09, segLen,
        this.pal.mat.leaf, 'tendril', rnd);
      z -= segLen;
      remaining -= segLen;
    }
  };

  /* One thin backing plate per crown module.

     The crown does not actually cover its modules. Rounded blossoms cover only
     pi/4 of their footprint, and measured across links and species the WORST
     module sits at 34% plan-view coverage even while the mean is 99% - and it
     is the worst that breaks. Without a plate, clearing the carpet from under
     the tree lets paving show through those gaps and lifts the module toward
     light.

     The plate is a FULL-MODULE FLAT BOX, deliberately not the leaf primitive:
     a rounded solid would cover only ~79% of its own footprint and reintroduce
     the problem it exists to solve. It is grid-aligned with no jitter, buried
     at mid-crown height where the surrounding foliage hides it from the side,
     and a deep foliage tone so it reads as shadow within the canopy from
     above. */
  Ctx.prototype.backingPlates = function () {
    var pal = this.pal, n = this.n, rnd = this.rnd;
    /* Tinted inside the leaf ladder's own range rather than as a distinct
       shadow. At -0.30 the plate reads as a separate flat plane wherever a rim
       column's foliage is too sparse to hide it; at -0.12 it passes for one of
       the ladder's darker rungs and the eye stops separating it. Still well
       clear of the floor, and it covers the whole module either way. */
    var deep = { top: Palette.darken(pal.foliageTop, 0.12),
                 sideA: Palette.darken(pal.foliageTop, 0.26),
                 sideB: Palette.darken(pal.foliageTop, 0.38) };
    var keys = Object.keys(this.crownZ).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], mx = k % n, my = (k - mx) / n;
      var cz = this.crownZ[k];
      if (!isFinite(cz[0]) || !isFinite(cz[1])) continue;
      /* Sits LOW in the column, not at mid-height. At mid-height the plate
         sticks out past the foliage on rim columns, where the crown is thin,
         and reads as a flat lozenge - fine when leaves were boxes covering
         their whole footprint, visible now that they are rounded. Down at the
         crown's underside the whole canopy is above it, and at 35 degrees of
         elevation the crown hides its own underside. */
      /* Back at mid-crown. It was pushed down to the underside because a
         full-module plate stuck out past the rounded leaves on thin rim
         columns - but that was measured against leaves of 0.48-0.74 at
         pack 0.95. Foliage is now 0.55-0.82 at pack 0.84, dense enough to
         swallow it, and at the underside the overhang read as a flat shelf
         protruding below the crown's lower rim. */
      var mid = cz[0] + (cz[1] - cz[0]) * 0.42;
      this.out.push({
        x: mx, y: my, z: mid,
        w: 1, d: 1, h: 0.12,
        top: deep.top, side: deep.sideA, sideA: deep.sideA, sideB: deep.sideB,
        kind: 'leaf', shape: 'plate', leanX: 0, leanY: 0,
        phase: phaseAt(mx, my)
      });
    }
  };

  /* Ground. Every dark module becomes a raised block.

     Under the crown the block is coloured with fallen blossom rather than
     soil. Leaves are smaller than their module, so without this the gaps
     between them show brown from overhead and the crown reads as speckle on
     dirt; with it the module reads solid - leaf cube where there is a leaf,
     fallen petal where there is not, both in the same colour family. From the
     isometric view it also gives the drift of petals under the tree.

     Contrast is unaffected: both fallen tones are darker than the leaves
     above them, so they clear the floor by more than the foliage does. */
  /* Ground, drawn as MERGED REGIONS rather than one tile per module.

     One quad per module leaves a grid line between every pair of neighbours,
     and that grid is most of why the floor still read as squares - the
     reference has no visible cells at all, just flat regions of stone. So the
     matrix is first partitioned into colour categories, then greedily merged
     into maximal rectangles, and one quad is emitted per rectangle. The same
     pixels stay the same colour, so the code is untouched; every grid line
     interior to a rectangle simply disappears.

     Rectangles are capped rather than unbounded. An uncapped merge gives a few
     enormous flat quads, which trades a grid for cut paper; capping keeps the
     tone ladder varying at a coarser scale than the module grid, which is the
     texture the reference has. */
  var MERGE_CAP = 4;

  Ctx.prototype.groundBlocks = function () {
    var pal = this.pal, n = this.n, rnd = this.rnd;

    // 1. category per module, and the blade gate, decided per module as before
    var cat = [], grassAt = [];
    for (var y = 0; y < n; y++) {
      cat.push(new Array(n).fill(null));
      grassAt.push(new Array(n).fill(false));
      for (var x = 0; x < n; x++) {
        if (!this.matrix[y][x]) continue;
        var nz = cellNoise(x, y);
        if (this.claimed[y][x]) {
          cat[y][x] = this.species === 'ginkgo'
            ? (nz > 0.5 ? 'fallen' : 'fallen2') : 'plaza';
        } else {
          var rx = (x + 0.5) / n - 0.5, ry = (y + 0.5) / n - 0.5;
          var rad = Math.sqrt(rx * rx + ry * ry) / 0.7071;
          var isGrass = nz < (rad - 0.35) * 1.6;
          cat[y][x] = isGrass ? 'grass' : 'soil';
          grassAt[y][x] = isGrass;
        }
      }
    }

    // 2. greedy maximal rectangles per category
    var mats = { plaza: pal.mat.plaza, soil: pal.mat.soil, grass: pal.mat.grass,
                 fallen: pal.mat.fallen, fallen2: pal.mat.fallen2 };
    var used = [];
    for (var u = 0; u < n; u++) used.push(new Array(n).fill(false));
    for (var my = 0; my < n; my++) {
      for (var mx = 0; mx < n; mx++) {
        var c = cat[my][mx];
        if (!c || used[my][mx]) continue;
        var w = 1;
        while (w < MERGE_CAP && mx + w < n && cat[my][mx + w] === c && !used[my][mx + w]) w++;
        var h = 1;
        outer: while (h < MERGE_CAP && my + h < n) {
          for (var k = 0; k < w; k++) {
            if (cat[my + h][mx + k] !== c || used[my + h][mx + k]) break outer;
          }
          h++;
        }
        for (var a = 0; a < h; a++) for (var b = 0; b < w; b++) used[my + a][mx + b] = true;
        var mat = mats[c];
        var tone = mat.ladder
          ? pickRung(mat.ladder, toneHash(mx, my, 7)) : mat;
        this.out.push({
          x: mx, y: my, z: SLAB_TOP, w: w, d: h, h: 0.02,
          top: tone.top, side: tone.sideA, sideA: tone.sideA, sideB: tone.sideB,
          kind: 'ground', shape: 'tile', leanX: 0, leanY: 0,
          phase: phaseAt(mx, my)
        });
      }
    }

    // 3. blades, still per module - a tuft belongs to its own square metre
    for (var gy = 0; gy < n; gy++) {
      for (var gx = 0; gx < n; gx++) {
        if (!grassAt[gy][gx]) continue;
        var nz2 = cellNoise(gx, gy);
        var patch = cellNoise(Math.floor(gx / 3) + 71, Math.floor(gy / 3) + 131);
        var dens = patch * 0.62 + nz2 * 0.38;
        var blades = 2 + Math.floor(Math.pow(dens, 1.7) * 6);   // long tail
        var tcx = 0.30 + rnd() * 0.40, tcy = 0.30 + rnd() * 0.40;
        for (var bi = 0; bi < blades; bi++) {
          var bw = 0.09 + rnd() * 0.08;
          var sx = Math.max(0, Math.min(1 - bw, tcx + (rnd() - 0.5) * 0.46 - bw / 2));
          var sy = Math.max(0, Math.min(1 - bw, tcy + (rnd() - 0.5) * 0.46 - bw / 2));
          var dx = sx + bw / 2 - tcx, dy = sy + bw / 2 - tcy;
          var dist = Math.min(1, Math.hypot(dx, dy) / 0.33);
          var bh2 = (0.34 + rnd() * 0.22) * (1.35 - 0.65 * dist);
          var before = this.out.length;
          place(this.out, gx, gy, SLAB_TOP + 0.02, bw, bh2, pal.mat.grass, 'blade', rnd);
          var v = this.out[before];
          v.x = gx + sx; v.y = gy + sy;
          var ang = Math.atan2(dy, dx) + (rnd() - 0.5) * 0.8;
          var lim = 0.98;
          v.leanX = Math.max(-sx * lim, Math.min(((1 - bw) - sx) * lim, Math.cos(ang) * 0.34));
          v.leanY = Math.max(-sy * lim, Math.min(((1 - bw) - sy) * lim, Math.sin(ang) * 0.34));
        }
      }
    }
  };

  // --- species -----------------------------------------------------------
  /* CROWN WIDTH. Three of the four species converged on the same correction -
     radius x1.15, heights x0.85-0.95 - when swept against the reference. The
     crowns were uniformly about 15% too narrow and slightly too tall, which is
     why they read as tall lumps rather than canopies. Crown width over plot
     width lands near 0.60, matching the reference.

     The ginkgo is deliberately excluded. Its best fit is x1.40, but the target is
     borrowed: the reference only ever shows the cherry, and a eucalyptus
     genuinely is sparse and open-crowned. Widening it to match would cost the
     one thing that distinguishes its silhouette. Match the family, not the
     cherry's exact numbers - the willow likewise sits broader than tall.

     Only the RADIUS correction is applied. The accompanying height reduction
     was derived against a taller baseline than this one; applied here it drove
     the silhouette to 0.874-0.888, under the floor. Widening alone brings the
     crown aspect down without touching the silhouette, which is the part that
     was actually wrong.

     Proportions are tuned against a measured silhouette aspect (rendered
     diorama height / plot width at t=0), not by eye. The target band is
     0.90-1.05; a crown that tops out around 0.9n lands there. Anything much
     flatter reads as a disc floating over a plaza, and - because a flat crown
     has nothing behind its gaps - it is also what makes the matrix carving
     show through as lace.

     Every species leaves clear air between the ground blocks and the crown's
     underside, so the trunk is visible for roughly a fifth of tree height. */

  /* Spring. Short trunk, broad crown of overlapping puffs at staggered
     heights - layered rather than one ball, which is what separates its
     silhouette from the oak. */
  function plantSakura(c, n, cx, cy) {
    var rnd = c.rnd;
    var trunkH = n * 0.26;
    var R = n * 0.350;                       // the reference tree; the anchor
    c.trunk(cx, cy, 0, trunkH, 0.62);

    /* A cherry is TIERED, not spherical: broad horizontal shelves of blossom
       with the limbs showing between them. The previous crown was one cloud of
       radius R with four satellites at 0.55R and radius 0.66R - they sat
       entirely inside the parent, so the union was a smooth ellipsoid and read
       as a ball. Satellites now ride at 0.78R and are smaller than the gap
       they leave, so the outline is lobed and the sky comes through. */
    var LOBES = 7;
    // core: continuous, so the crown never shows a bite
    c.clump(cx + 0.5, cy + 0.5, trunkH + n * 0.33, R * 0.88, n * 0.24, 6);
    for (var i = 0; i < LOBES; i++) {
      var a = (i / LOBES) * Math.PI * 2 + rnd() * 0.45;
      var lift = (i % 2) ? 0.05 : 0.0;       // alternate heights = tiered outline
      c.clump(cx + 0.5 + Math.cos(a) * R * 0.60,
              cy + 0.5 + Math.sin(a) * R * 0.60,
              trunkH + n * (0.25 + lift), R * 0.40, n * 0.135, 3);
      // a limb out to each lobe, so the branching reads in the gaps
      c.limb(cx + 0.5, cy + 0.5, a, R * 0.72, trunkH * 0.92, n * 0.045, 0.34);
    }
    c.clump(cx + 0.5, cy + 0.5, trunkH + n * 0.62, R * 0.46, n * 0.155, 4);
  }

  /* Summer. Thick trunk, heavy forking limbs, deep rounded crown - taller and
     lumpier than the sakura. */
  function plantOak(c, n, cx, cy) {
    var rnd = c.rnd;
    var trunkH = n * 0.28;
    var R = n * 0.467;                       // biggest and broadest
    c.trunk(cx, cy, 0, trunkH, 0.82);
    c.trunk(cx + 1, cy, 0, trunkH * 0.7, 0.42);
    c.trunk(cx, cy + 1, 0, trunkH * 0.7, 0.42);

    var limbs = 5 + Math.floor(rnd() * 2);
    for (var i = 0; i < limbs; i++) {
      c.limb(cx + 0.5, cy + 0.5, (i / limbs) * Math.PI * 2 + rnd() * 0.6,
        R * (0.5 + rnd() * 0.4), trunkH * 0.66, n * 0.10, 0.48);
    }
    /* An oak crown is a cluster of heavy masses, not one dome. The lobes are
       deliberately uneven in radius and height - an oak is the lumpiest
       silhouette of the four and that irregularity is the species read. */
    c.clump(cx + 0.5, cy + 0.5, trunkH + n * 0.34, R * 0.82, n * 0.27, 7);
    var OLOBES = 7;
    for (var j = 0; j < OLOBES; j++) {
      var a = (j / OLOBES) * Math.PI * 2 + rnd() * 0.6;
      var far = 0.52 + rnd() * 0.18;             // uneven reach, but overlapping
      var rr = R * (0.36 + rnd() * 0.16);        // uneven mass
      c.clump(cx + 0.5 + Math.cos(a) * R * far,
              cy + 0.5 + Math.sin(a) * R * far,
              trunkH + n * (0.26 + rnd() * 0.20), rr, n * (0.17 + rnd() * 0.09), 3);
      c.limb(cx + 0.5, cy + 0.5, a, R * (far + 0.16), trunkH * 0.80, n * 0.085, 0.40);
    }
    c.clump(cx + 0.5, cy + 0.5, trunkH + n * 0.66, R * 0.42, n * 0.19, 4);
  }

  /* Autumn ginkgo. Columnar and distinctly taller than wide - it holds the far
     end of the silhouette range, which is why a broad maple would be the wrong
     swap however good crimson looks: it would collide with the oak and the
     willow and collapse the spread. Sparse, open branching, brilliant gold,
     and the one species that keeps a fallen-leaf carpet under it. */
  function plantGinkgo(c, n, cx, cy) {
    var rnd = c.rnd;
    /* Upright and narrow, which is the ginkgo's whole silhouette. The first
       version reached its 1.15 aspect target with a 0.95n trunk carrying a
       small ball: 59% of the tree was bare pole and the crown itself measured
       WIDER than tall (0.91). It passed the assertion and looked like a
       lollipop, because the assertion measures the diorama, not the crown. */
    var trunkH = n * 0.58;              // a clear bole, but the crown is the tree
    c.trunk(cx, cy, 0, trunkH, 0.56);   // wide enough for the pale bark to read

    /* Clumps ride a vertical axis and their offset radius tapers toward the
       apex, so the crown closes to a point instead of a flat top. Height is
       the loop index, not a random draw: every other clump sits at a random
       radius, so letting height be random too made whether the crown reached
       its nominal top depend on which columns the matrix happens to leave
       dark - which spread the measured silhouette across links by 0.14, most
       of the assertion band. Indexing height pins the apex and the random
       radii only ever fill in around it. */
    /* crownH carries the species' height. Shortening the bole from 0.95n cost
       0.10 of silhouette aspect and collapsed the four-species spread to 0.208,
       under the 0.22 assertion; the height has to come back, but through the
       crown rather than the pole, or it is a lollipop again. Clump count scales
       with it so the axis keeps the same ~0.048n spacing and does not thin. */
    var crownH = n * 0.70;
    var clumps = 19 + Math.floor(rnd() * 4);
    for (var i = 0; i < clumps; i++) {
      var u = i / (clumps - 1);          // 0 at the crown base, 1 at the apex
      var taper = 1 - 0.62 * u * u;
      var a = rnd() * Math.PI * 2;
      /* A ginkgo is a FAN: narrow at the bole and widening toward the top,
         the opposite of a conifer. Radius grows with u before the apex taper
         pulls it back, which is what separates it from a column of blobs. */
      var flare = 0.55 + 0.85 * u;
      var rad = (0.03 + rnd() * 0.17) * n * taper * flare;
      /* Radius and sub-count both up: on a narrow axis, consecutive clumps
         were not overlapping, and a gap on a columnar crown reads as a bite
         taken out of the tree rather than as foliage texture. */
      c.clump(cx + 0.5 + Math.cos(a) * rad,
              cy + 0.5 + Math.sin(a) * rad,
              trunkH + n * 0.02 + u * crownH,
              n * (0.205 - 0.060 * u), n * (0.160 - 0.030 * u), 3);
    }
    // The apex clump sits on the trunk column, which is dark by construction.
    c.cloud(cx + 0.5, cy + 0.5, trunkH + n * 0.02 + crownH, n * 0.085, n * 0.120);

    // Ascending limbs, the ginkgo's other signature: rise is most of the
    // branch length rather than a third of it.
    for (var b = 0; b < 5; b++) {
      c.limb(cx + 0.5, cy + 0.5, rnd() * Math.PI * 2, n * 0.11,
        trunkH * 0.72, n * 0.20, 0.30);
    }
  }

  /* Winter. A dome of foliage with long jointed tendrils falling from beneath
     its outer rim, nearly to the ground. */
  function plantWillow(c, n, cx, cy) {
    var rnd = c.rnd;
    var trunkH = n * 0.30;
    var R = n * 0.468;                       // broad and low, but not a ball
    var domeZ = trunkH + n * 0.215;  // low dome: willow anchors the low end
                                     // of the four-species silhouette spread
    c.trunk(cx, cy, 0, trunkH, 0.66);
    // flat-bottomed rather than a true dome: -0.75 keeps the underside high
    // enough to leave the trunk visible while still reading as a canopy.
    // -0.75 keeps the underside high enough to leave the trunk visible
    c.clump(cx + 0.5, cy + 0.5, domeZ, R * 1.02, n * 0.235, 8, -0.75);

    var strands = Math.round(n * 1.4);
    for (var t = 0; t < strands; t++) {
      var a = rnd() * Math.PI * 2;
      /* Strands hang from the rim rather than the whole underside, and fall
         further: a willow is read by the curtain, not by the dome. */
      var r = R * (0.72 + rnd() * 0.34);
      var top = domeZ - n * 0.02;
      c.tendril(Math.floor(cx + 0.5 + Math.cos(a) * r),
                Math.floor(cy + 0.5 + Math.sin(a) * r),
                top, Math.max(1.0, top - (0.05 + rnd() * 0.11) * n));
    }
  }

  var PLANTERS = {
    sakura: plantSakura, oak: plantOak, ginkgo: plantGinkgo, willow: plantWillow
  };

  function build(opts) {
    var matrix = opts.matrix;
    var n = matrix.length;
    var pal = Palette.build(opts.species, opts.swatch);
    var rnd = mulberry32(hashString(opts.seed + '|' + opts.species + '|' + opts.swatch));
    var c = new Ctx(matrix, pal, rnd, opts.species);

    var centre = nearestDark(matrix, (n - 1) / 2, (n - 1) / 2);
    // Plant first, so groundBlocks knows which modules are under the crown.
    /* Fail loudly on an unknown species. This used to fall back to the oak,
       which meant a stale name in the harness silently rendered a second oak -
       the sweep tested the oak twice, never tested the new species at all, and
       the only symptom was a species-spread assertion failing for what looked
       like a tuning problem. A silent fallback on a typo is worse than a
       crash. */
    var planter = PLANTERS[opts.species];
    if (!planter) throw new Error('unknown species: ' + opts.species);
    planter(c, n, centre[0], centre[1]);
    // One pass over the merged spans, after every cloud has been recorded.
    /* pack 0.95 -> 0.84 overlaps each leaf further onto the one below, and
       bigger leaves close the gaps between columns: the crown reads as
       foliage rather than as a scatter with the plot showing through. */
    c.growCanopy(0.84, 0.55, 0.82);
    c.backingPlates();
    var canopy = c.out.length;
    c.groundBlocks();

    var maxZ = 0, claimedCount = 0;
    for (var i = 0; i < c.out.length; i++) maxZ = Math.max(maxZ, c.out[i].z + c.out[i].h);
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (c.claimed[y][x]) claimedCount++;

    /* Crown-only geometry. heightFraction covers the whole diorama including
       the fallen carpet, so it can look healthy while the crown itself is a
       flat disc - which is exactly the failure that made the canopy lacy.
       These measure the crown alone. */
    var cxMin = Infinity, cxMax = -Infinity, cyMin = Infinity, cyMax = -Infinity;
    for (var v = 0; v < c.out.length; v++) {
      var vx = c.out[v];
      if (vx.kind !== 'leaf') continue;
      if (vx.x < cxMin) cxMin = vx.x;
      if (vx.x + vx.w > cxMax) cxMax = vx.x + vx.w;
      if (vx.y < cyMin) cyMin = vx.y;
      if (vx.y + vx.d > cyMax) cyMax = vx.y + vx.d;
    }
    /* Bake the wind response into each voxel, so both renderers share one law
       instead of each reimplementing pow(z, 1.4).

       Height is normalised by maxZ. Using absolute z made displacement grow
       with the tree, so a version 10 code swayed harder than a version 2 one -
       2.22 modules of crown sway at n=25 rising to 3.26 at n=33, roughly 9% of
       plot width either way. As a fraction of tree height it is scale-free.
       The renderer multiplies these by WIND_AMP, which is now a displacement
       in modules at the crown top. */
    var mz = maxZ > 0 ? maxZ : 1;
    for (var w = 0; w < c.out.length; w++) {
      var vw = c.out[w];
      var stiff = STIFFNESS[vw.kind];
      if (stiff === undefined) stiff = 1;
      vw.swayLo = stiff * Math.pow(Math.max(0, vw.z) / mz, 1.4);
      vw.swayHi = stiff * Math.pow(Math.max(0, vw.z + vw.h) / mz, 1.4);
    }

    var crownW = isFinite(cxMin) ? Math.max(cxMax - cxMin, cyMax - cyMin) : 0;
    var crownH = isFinite(c.crownTop) ? c.crownTop - c.crownBottom : 0;
    var groundTop = SLAB_TOP + 0.82;

    var crownTops = [];
    var ckeys = Object.keys(c.crownZ);
    for (var ci = 0; ci < ckeys.length; ci++) {
      var ck = Number(ckeys[ci]);
      var czz = c.crownZ[ck];
      if (!czz || !isFinite(czz[1])) continue;
      crownTops.push({ x: ck % n, y: (ck - (ck % n)) / n, z: czz[1] });
    }

    return {
      matrix: matrix, n: n, palette: pal, voxels: c.out, maxZ: maxZ,
      /* Top of each crown column. Used to sit snow on a winter canopy as a
         decorative layer: the audited TOP FACE of a leaf is the surface the
         code is read from, so tinting it white would lift dark modules toward
         light and break scanning. Caps are drawn over it and faded out with
         the weather, long before the plan view. */
      crownTops: crownTops,
      centre: centre, species: opts.species,
      stats: {
        total: c.out.length,
        canopy: canopy,
        ground: c.out.length - canopy,
        claimed: claimedCount,
        heightFraction: maxZ / n,
        crownTop: isFinite(c.crownTop) ? c.crownTop : 0,
        crownBottom: isFinite(c.crownBottom) ? c.crownBottom : 0,
        crownWidth: crownW,
        // 1.0 is a ball; well under 1 is a disc you can see through
        crownAspect: crownW > 0 ? crownH / crownW : 0,
        // clear air between the ground blocks and the crown's underside
        trunkGap: (isFinite(c.crownBottom) ? c.crownBottom : 0) - groundTop,
        trunkVisibleFraction: maxZ > 0
          ? ((isFinite(c.crownBottom) ? c.crownBottom : 0) - groundTop) / maxZ : 0
      }
    };
  }

  return {
    SPECIES: SPECIES,
    STIFFNESS: STIFFNESS,
    SLAB_BOTTOM: SLAB_BOTTOM,
    SLAB_TOP: SLAB_TOP,
    build: build,
    hashString: hashString,
    mulberry32: mulberry32,
    phaseAt: phaseAt
  };
});
