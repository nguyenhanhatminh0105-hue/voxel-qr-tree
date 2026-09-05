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

  // Per-voxel phase for the wind, hashed from position so it is stable across
  // frames and independent of draw order.
  function phaseAt(x, y, z) {
    var h = Math.imul(((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >>> 0, 2654435761) >>> 0;
    return (h / 4294967296) * Math.PI * 2;
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

  var SPECIES = [
    { id: 'sakura', season: 'Spring', name: 'Sakura', fall: 'petals' },
    { id: 'oak', season: 'Summer', name: 'Oak', fall: 'seeds' },
    { id: 'gum', season: 'Autumn', name: 'Gum', fall: 'leaves' },
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
    var ox = slack > 0 ? rnd() * slack : 0;
    var oy = slack > 0 ? rnd() * slack : 0;
    out.push({
      x: mx + ox, y: my + oy, z: z,
      w: size, d: size, h: height,
      top: mat.top, side: mat.sideA, sideA: mat.sideA, sideB: mat.sideB,
      kind: kind,
      phase: phaseAt(mx, my, Math.round(z * 4))
    });
  }

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
  function Ctx(matrix, pal, rnd) {
    this.matrix = matrix;
    this.n = matrix.length;
    this.pal = pal;
    this.rnd = rnd;
    this.isDark = makeDark(matrix);
    this.out = [];
    this.claimed = [];
    for (var i = 0; i < this.n; i++) this.claimed.push(new Array(this.n).fill(false));
  }

  Ctx.prototype.claim = function (mx, my) {
    if (mx >= 0 && my >= 0 && mx < this.n && my < this.n) this.claimed[my][mx] = true;
  };

  /* Scatter foliage through an ellipsoid. Cells outside the matrix or on light
     modules simply produce nothing - that is the carving. Several samples can
     land in the same column at different heights, which gives the "several per
     column at varied heights" texture. */
  Ctx.prototype.cloud = function (cx, cy, cz, r, halfH, density, sizeLo, sizeHi) {
    var rnd = this.rnd;
    var count = Math.round(density * Math.PI * r * r);
    for (var i = 0; i < count; i++) {
      var ux, uy, uz, m;
      do {
        ux = rnd() * 2 - 1; uy = rnd() * 2 - 1; uz = rnd() * 2 - 1;
        m = ux * ux + uy * uy + uz * uz;
      } while (m > 1);
      var mx = Math.floor(cx + ux * r), my = Math.floor(cy + uy * r);
      if (!this.isDark(mx, my)) continue;
      this.claim(mx, my);
      var size = sizeLo + rnd() * (sizeHi - sizeLo);
      // height close to the plan size: flat discs stack into visible gaps,
      // roughly cubic leaves merge into a mass
      place(this.out, mx, my, cz + uz * halfH, size, size * (0.95 + rnd() * 0.6),
        this.pal.mat.leaf, 'leaf', rnd);
    }
  };

  // A dome: the upper half of an ellipsoid.
  Ctx.prototype.dome = function (cx, cy, cz, r, halfH, density, sizeLo, sizeHi) {
    var rnd = this.rnd;
    var count = Math.round(density * Math.PI * r * r);
    for (var i = 0; i < count; i++) {
      var ux, uy, uz, m;
      do {
        ux = rnd() * 2 - 1; uy = rnd() * 2 - 1; uz = rnd();
        m = ux * ux + uy * uy + uz * uz;
      } while (m > 1);
      var mx = Math.floor(cx + ux * r), my = Math.floor(cy + uy * r);
      if (!this.isDark(mx, my)) continue;
      this.claim(mx, my);
      var size = sizeLo + rnd() * (sizeHi - sizeLo);
      place(this.out, mx, my, cz + uz * halfH, size, size * 1.05,
        this.pal.mat.leaf, 'leaf', rnd);
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

  /* Ground. Every dark module becomes a raised block.

     Under the crown the block is coloured with fallen blossom rather than
     soil. Leaves are smaller than their module, so without this the gaps
     between them show brown from overhead and the crown reads as speckle on
     dirt; with it the module reads solid - leaf cube where there is a leaf,
     fallen petal where there is not, both in the same colour family. From the
     isometric view it also gives the drift of petals under the tree.

     Contrast is unaffected: both fallen tones are darker than the leaves
     above them, so they clear the floor by more than the foliage does. */
  Ctx.prototype.groundBlocks = function () {
    var pal = this.pal, n = this.n, rnd = this.rnd;
    for (var my = 0; my < n; my++) {
      for (var mx = 0; mx < n; mx++) {
        if (!this.matrix[my][mx]) continue;
        var nz = cellNoise(mx, my);
        var mat;
        if (this.claimed[my][mx]) {
          mat = nz > 0.5 ? pal.mat.fallen : pal.mat.fallen2;
        } else {
          // brown soil where the crown does not reach, grass elsewhere
          mat = nz > 0.45 ? pal.mat.grass : pal.mat.soil;
        }
        // Chunky enough to read as terrain. At 0.26 the blocks look like flat
        // plates scattered on the slab, which is the very thing raising them
        // was meant to fix.
        place(this.out, mx, my, SLAB_TOP, 1, 0.52 + nz * 0.30, mat, 'ground', rnd);
      }
    }
  };

  // --- species -----------------------------------------------------------

  /* Spring. Short trunk, broad crown of several overlapping puffs at
     staggered heights - deliberately flat and layered rather than one ball,
     which is what separates its silhouette from the oak. Proportioned so the
     crown top lands near 0.51 n: a crown at 0.35 n reads as a shrub on a
     large empty plaza however good the foliage is. */
  function plantSakura(c, n, cx, cy) {
    var rnd = c.rnd;
    var trunkH = n * 0.20;
    var R = n * 0.30 * 0.98;
    c.trunk(cx, cy, 0, trunkH, 0.46);

    c.cloud(cx + 0.5, cy + 0.5, trunkH + n * 0.19, R, n * 0.115, 2.4, 0.34, 0.56);
    for (var i = 0; i < 4; i++) {
      var a = (i / 4) * Math.PI * 2 + rnd() * 0.5;
      c.cloud(cx + 0.5 + Math.cos(a) * R * 0.60,
              cy + 0.5 + Math.sin(a) * R * 0.60,
              trunkH + n * (0.12 + rnd() * 0.07),
              R * 0.66, n * 0.10, 2.4, 0.34, 0.56);
    }
    c.cloud(cx + 0.5, cy + 0.5, trunkH + n * 0.31, R * 0.54, n * 0.085, 2.4, 0.30, 0.50);
  }

  /* Summer. Thick trunk, heavy forking limbs, deep rounded crown - taller and
     lumpier than the sakura. */
  function plantOak(c, n, cx, cy) {
    var rnd = c.rnd;
    var trunkH = n * 0.24;
    var R = n * 0.30;
    c.trunk(cx, cy, 0, trunkH, 0.70);
    c.trunk(cx + 1, cy, 0, trunkH * 0.7, 0.42);
    c.trunk(cx, cy + 1, 0, trunkH * 0.7, 0.42);

    var limbs = 5 + Math.floor(rnd() * 2);
    for (var i = 0; i < limbs; i++) {
      c.limb(cx + 0.5, cy + 0.5, (i / limbs) * Math.PI * 2 + rnd() * 0.6,
        R * (0.5 + rnd() * 0.4), trunkH * 0.62, n * 0.09, 0.48);
    }
    c.cloud(cx + 0.5, cy + 0.5, trunkH + n * 0.20, R, n * 0.20, 2.4, 0.38, 0.62);
    for (var j = 0; j < 4; j++) {
      var a = (j / 4) * Math.PI * 2 + rnd() * 0.7;
      c.cloud(cx + 0.5 + Math.cos(a) * R * 0.55,
              cy + 0.5 + Math.sin(a) * R * 0.55,
              trunkH + n * (0.16 + rnd() * 0.12),
              R * 0.62, n * 0.15, 2.4, 0.38, 0.62);
    }
  }

  /* Autumn. Tall pale trunk, bare for most of its height, then a sparse open
     crown of scattered clumps with big gaps between them. The near-white bark
     lives entirely on the side faces - see palette.js. */
  function plantGum(c, n, cx, cy) {
    var rnd = c.rnd;
    var trunkH = n * 0.42;
    c.trunk(cx, cy, 0, trunkH, 0.56);   // wide enough for the pale bark to read

    var clumps = 8 + Math.floor(rnd() * 3);
    for (var i = 0; i < clumps; i++) {
      var a = rnd() * Math.PI * 2;
      var rad = (0.05 + rnd() * 0.20) * n;
      c.cloud(cx + 0.5 + Math.cos(a) * rad,
              cy + 0.5 + Math.sin(a) * rad,
              trunkH * (0.80 + rnd() * 0.36),
              n * 0.11, n * 0.075, 3.4, 0.30, 0.50);
    }
    for (var b = 0; b < 3; b++) {
      c.limb(cx + 0.5, cy + 0.5, rnd() * Math.PI * 2, n * 0.10,
        trunkH * 0.86, n * 0.05, 0.28);
    }
  }

  /* Winter. A dome of foliage with long jointed tendrils falling from beneath
     its outer rim, nearly to the ground. */
  function plantWillow(c, n, cx, cy) {
    var rnd = c.rnd;
    var trunkH = n * 0.22;
    var R = n * 0.29;
    var domeZ = trunkH + n * 0.13;
    c.trunk(cx, cy, 0, trunkH, 0.54);
    c.dome(cx + 0.5, cy + 0.5, domeZ, R, n * 0.16, 5.2, 0.34, 0.56);

    var strands = Math.round(n * 1.4);
    for (var t = 0; t < strands; t++) {
      var a = rnd() * Math.PI * 2;
      var r = R * (0.60 + rnd() * 0.42);
      var top = domeZ - n * 0.01;
      c.tendril(Math.floor(cx + 0.5 + Math.cos(a) * r),
                Math.floor(cy + 0.5 + Math.sin(a) * r),
                top, Math.max(1.0, top - (0.02 + rnd() * 0.07) * n));
    }
  }

  var PLANTERS = {
    sakura: plantSakura, oak: plantOak, gum: plantGum, willow: plantWillow
  };

  function build(opts) {
    var matrix = opts.matrix;
    var n = matrix.length;
    var pal = Palette.build(opts.species, opts.swatch);
    var rnd = mulberry32(hashString(opts.seed + '|' + opts.species + '|' + opts.swatch));
    var c = new Ctx(matrix, pal, rnd);

    var centre = nearestDark(matrix, (n - 1) / 2, (n - 1) / 2);
    // Plant first, so groundBlocks knows which modules are under the crown.
    (PLANTERS[opts.species] || plantOak)(c, n, centre[0], centre[1]);
    var canopy = c.out.length;
    c.groundBlocks();

    var maxZ = 0, claimedCount = 0;
    for (var i = 0; i < c.out.length; i++) maxZ = Math.max(maxZ, c.out[i].z + c.out[i].h);
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (c.claimed[y][x]) claimedCount++;

    return {
      matrix: matrix, n: n, palette: pal, voxels: c.out, maxZ: maxZ,
      centre: centre, species: opts.species,
      stats: {
        total: c.out.length,
        canopy: canopy,
        ground: c.out.length - canopy,
        claimed: claimedCount,
        heightFraction: maxZ / n
      }
    };
  }

  return {
    SPECIES: SPECIES,
    SLAB_BOTTOM: SLAB_BOTTOM,
    SLAB_TOP: SLAB_TOP,
    build: build,
    hashString: hashString,
    mulberry32: mulberry32,
    phaseAt: phaseAt
  };
});
