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

   Gaps in foliage are safe. The soil beneath a dark module already reproduces
   that module at roughly 10:1 against the paving, which beats the foliage
   itself at ~5:1. A rule forcing foliage to fill its module would buy nothing
   and would turn every crown into a stack of crates.

   A cube may be smaller than its module and offset within it, but must never
   cross the edge - see place(), which is the only way voxels are created.
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
    var ox = rnd() * slack;
    var oy = rnd() * slack;
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

  /* Scatter foliage through an ellipsoid. Cells outside the matrix or on light
     modules simply produce nothing - that is the carving. Several samples can
     land in the same column at different heights, which is what gives the
     "several per column at varied heights" texture. */
  function cloud(out, isDark, cx, cy, cz, rx, ry, rz, count, pal, rnd, sizeLo, sizeHi) {
    for (var i = 0; i < count; i++) {
      // rejection-sample a point inside the unit sphere, then scale
      var ux, uy, uz, m;
      do {
        ux = rnd() * 2 - 1; uy = rnd() * 2 - 1; uz = rnd() * 2 - 1;
        m = ux * ux + uy * uy + uz * uz;
      } while (m > 1);
      var px = cx + ux * rx, py = cy + uy * ry, pz = cz + uz * rz;
      var mx = Math.floor(px), my = Math.floor(py);
      if (!isDark(mx, my)) continue;
      var size = sizeLo + rnd() * (sizeHi - sizeLo);
      // height close to the plan size: flat discs stack into visible gaps,
      // roughly cubic leaves merge into a mass
      place(out, mx, my, pz, size, size * (0.95 + rnd() * 0.6), pal.mat.leaf, 'leaf', rnd);
    }
  }

  function trunk(out, isDark, mx, my, z0, height, pal, rnd, width) {
    if (!isDark(mx, my)) return false;
    // One column on a dark cell is dark at every height, so the trunk is
    // always whole. Segmented so the wind shear reads along its length.
    var seg = 0.8;
    for (var z = z0; z < z0 + height - 1e-6; z += seg) {
      var h = Math.min(seg, z0 + height - z);
      var size = width * (1 - 0.12 * (z - z0) / Math.max(1, height));
      place(out, mx, my, z, size, h, pal.mat.bark, 'bark', rnd);
    }
    return true;
  }

  /* Willow tendril: narrow in plan, continuous in z. A scatter of cubes here
     reads as a bush, not a hanging branch, so this is its own primitive - a
     few tall jointed segments, each staying inside the module. */
  function tendril(out, isDark, mx, my, zTop, length, pal, rnd) {
    if (!isDark(mx, my)) return;
    var joints = 2 + Math.floor(rnd() * 3);
    var remaining = length;
    var z = zTop;
    for (var j = 0; j < joints && remaining > 0.3; j++) {
      var segLen = j === joints - 1 ? remaining : remaining * (0.35 + rnd() * 0.4);
      segLen = Math.min(segLen, remaining);
      var width = 0.13 + rnd() * 0.09;
      place(out, mx, my, z - segLen, width, segLen, pal.mat.leaf, 'tendril', rnd);
      z -= segLen;
      remaining -= segLen;
    }
  }

  function grass(out, isDark, matrix, pal, rnd, density) {
    var n = matrix.length;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!matrix[y][x] || rnd() > density) continue;
        var tufts = 1 + Math.floor(rnd() * 2);
        for (var t = 0; t < tufts; t++) {
          place(out, x, y, 0, 0.16 + rnd() * 0.14, 0.18 + rnd() * 0.30,
            pal.mat.grass, 'grass', rnd);
        }
      }
    }
  }

  // --- species -----------------------------------------------------------
  // Each returns voxels; `s` scales everything to the matrix size so a v2 code
  // and a v10 code both grow a tree of sensible proportion.

  /* Spring. Short trunk, broad crown built from several overlapping puffs at
     staggered heights - deliberately flat and layered rather than a single
     ball, which is what separates its silhouette from the oak. */
  function plantSakura(out, isDark, matrix, pal, rnd, s, cx, cy) {
    var th = 2.6 * s;
    trunk(out, isDark, cx, cy, 0, th, pal, rnd, 0.42);
    var puffs = 5 + Math.floor(rnd() * 3);
    for (var i = 0; i < puffs; i++) {
      var ang = rnd() * Math.PI * 2;
      var rad = rnd() * 2.6 * s;
      cloud(out, isDark,
        cx + 0.5 + Math.cos(ang) * rad,
        cy + 0.5 + Math.sin(ang) * rad,
        th + 0.5 * s + rnd() * 1.5 * s,
        2.3 * s, 2.3 * s, 1.05 * s,          // flat-ish: rz much smaller than rx/ry
        Math.round(26 * s * s), pal, rnd, 0.34, 0.55);
    }
  }

  /* Summer. Thick trunk, heavy forking limbs, deep rounded crown. Taller and
     lumpier than the sakura. */
  function plantOak(out, isDark, matrix, pal, rnd, s, cx, cy) {
    var th = 4.2 * s;
    trunk(out, isDark, cx, cy, 0, th, pal, rnd, 0.68);
    // a couple of neighbouring columns thicken the bole where they are dark
    trunk(out, isDark, cx + 1, cy, 0, th * 0.72, pal, rnd, 0.4);
    trunk(out, isDark, cx, cy + 1, 0, th * 0.72, pal, rnd, 0.4);

    var limbs = 4 + Math.floor(rnd() * 3);
    for (var i = 0; i < limbs; i++) {
      var ang = (i / limbs) * Math.PI * 2 + rnd() * 0.7;
      var len = (1.8 + rnd() * 1.8) * s;
      var steps = Math.max(3, Math.round(len * 2.2));
      for (var k = 1; k <= steps; k++) {
        var f = k / steps;
        var px = cx + 0.5 + Math.cos(ang) * len * f;
        var py = cy + 0.5 + Math.sin(ang) * len * f;
        var pz = th * 0.62 + f * 2.1 * s;
        var mx = Math.floor(px), my = Math.floor(py);
        if (!isDark(mx, my)) continue;
        place(out, mx, my, pz, 0.46 - 0.14 * f, 0.55, pal.mat.bark, 'bark', rnd);
      }
    }
    var lobes = 4 + Math.floor(rnd() * 3);
    for (var j = 0; j < lobes; j++) {
      var a2 = rnd() * Math.PI * 2, r2 = rnd() * 2.4 * s;
      cloud(out, isDark,
        cx + 0.5 + Math.cos(a2) * r2,
        cy + 0.5 + Math.sin(a2) * r2,
        th + 2.4 * s + rnd() * 1.6 * s,
        2.8 * s, 2.8 * s, 2.1 * s,           // deep and rounded
        Math.round(34 * s * s), pal, rnd, 0.38, 0.60);
    }
  }

  /* Autumn. Tall pale trunk, bare for most of its height, then a sparse open
     crown of scattered clumps with big gaps between them. The near-white bark
     lives entirely on the side faces - see palette.js. */
  function plantGum(out, isDark, matrix, pal, rnd, s, cx, cy) {
    var th = 6.4 * s;
    trunk(out, isDark, cx, cy, 0, th, pal, rnd, 0.40);
    var clumps = 5 + Math.floor(rnd() * 4);
    for (var i = 0; i < clumps; i++) {
      var ang = rnd() * Math.PI * 2;
      var rad = (0.6 + rnd() * 2.6) * s;
      cloud(out, isDark,
        cx + 0.5 + Math.cos(ang) * rad,
        cy + 0.5 + Math.sin(ang) * rad,
        th * (0.82 + rnd() * 0.34),
        1.25 * s, 1.25 * s, 1.05 * s,
        Math.round(11 * s * s), pal, rnd, 0.30, 0.48);    // low count: open crown
    }
    // a few bare upper branch stubs to sell the height
    for (var b = 0; b < 3; b++) {
      var a = rnd() * Math.PI * 2;
      for (var k = 1; k <= 3; k++) {
        var mx = Math.floor(cx + 0.5 + Math.cos(a) * k * 0.8 * s);
        var my = Math.floor(cy + 0.5 + Math.sin(a) * k * 0.8 * s);
        if (!isDark(mx, my)) continue;
        place(out, mx, my, th * 0.86 + k * 0.35 * s, 0.26, 0.5, pal.mat.bark, 'bark', rnd);
      }
    }
  }

  /* Winter. A dome of foliage with long jointed tendrils falling from beneath
     its outer rim, nearly to the ground. */
  function plantWillow(out, isDark, matrix, pal, rnd, s, cx, cy) {
    var th = 3.4 * s;
    trunk(out, isDark, cx, cy, 0, th, pal, rnd, 0.52);

    var domeR = 3.1 * s;
    var domeZ = th + 1.5 * s;
    // upper half only, so it reads as a dome rather than a ball
    var n = Math.round(70 * s * s);
    for (var i = 0; i < n; i++) {
      var ux, uy, uz, m;
      do {
        ux = rnd() * 2 - 1; uy = rnd() * 2 - 1; uz = rnd();
        m = ux * ux + uy * uy + uz * uz;
      } while (m > 1);
      var px = cx + 0.5 + ux * domeR, py = cy + 0.5 + uy * domeR;
      var pz = domeZ + uz * 1.7 * s;
      var mx = Math.floor(px), my = Math.floor(py);
      if (!isDark(mx, my)) continue;
      var size = 0.34 + rnd() * 0.22;
      place(out, mx, my, pz, size, size * 1.05, pal.mat.leaf, 'leaf', rnd);
    }

    // tendrils from beneath the outer rim, falling nearly to the ground
    var strands = Math.round(16 * s);
    for (var t = 0; t < strands; t++) {
      var a = rnd() * Math.PI * 2;
      var r = domeR * (0.62 + rnd() * 0.42);
      var mx2 = Math.floor(cx + 0.5 + Math.cos(a) * r);
      var my2 = Math.floor(cy + 0.5 + Math.sin(a) * r);
      var top = domeZ - 0.2 * s;
      var len = top - (0.15 + rnd() * 0.9) * s;
      tendril(out, isDark, mx2, my2, top, Math.max(0.8, len), pal, rnd);
    }
  }

  var PLANTERS = {
    sakura: plantSakura, oak: plantOak, gum: plantGum, willow: plantWillow
  };

  /* Build the whole diorama. Returns voxels plus the matrix, so the renderer
     needs nothing else. */
  function build(opts) {
    var matrix = opts.matrix;
    var n = matrix.length;
    var pal = Palette.build(opts.species, opts.swatch);
    var rnd = mulberry32(hashString(opts.seed + '|' + opts.species + '|' + opts.swatch));
    var isDark = makeDark(matrix);
    var s = n / 13;                       // proportion tracks the matrix size

    var centre = nearestDark(matrix, (n - 1) / 2, (n - 1) / 2);
    var out = [];
    grass(out, isDark, matrix, pal, rnd, 0.20);
    (PLANTERS[opts.species] || plantOak)(out, isDark, matrix, pal, rnd, s, centre[0], centre[1]);

    var maxZ = 0;
    for (var i = 0; i < out.length; i++) maxZ = Math.max(maxZ, out[i].z + out[i].h);

    return {
      matrix: matrix, n: n, palette: pal, voxels: out, maxZ: maxZ,
      centre: centre, species: opts.species
    };
  }

  return {
    SPECIES: SPECIES,
    build: build,
    hashString: hashString,
    mulberry32: mulberry32,
    phaseAt: phaseAt
  };
});
