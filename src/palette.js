/* ===========================================================================
   palette.js - colour, and the contrast floor that governs it.

   The whole diorama is a QR code seen from above, so every surface that can
   land on a dark module competes with the paving for a scanner's attention.
   WCAG-style relative luminance contrast is the working proxy: anything that
   can sit over a dark module must clear MIN_RATIO against the paving colour.

   That floor is not a style guide, it is a hard constraint. Pastel sakura pink
   is about 1.2:1 against pale paving and simply will not scan.

   But the floor is 3:1, and shipping colours at 5:1 or 8:1 spends headroom on
   nothing while making the whole scene read as dark wine. Every foliage swatch
   here sits just above 3.2:1, picked as a saturated hue AT that luminance
   rather than a pastel multiplied toward black - see SWATCHES for why the
   difference matters.

   Two further rules keep the two colour families from converging:
     - a surface that can sit on a DARK module may only ever be varied DARKER
     - a surface on PAVING may only ever be varied LIGHTER
   Violate those and the render still looks fine while the code quietly dies.

   Side faces are exempt. They are never visible from straight overhead, so
   they can carry colour the code could not survive on its top faces - that is
   what lets the gum have near-white bark.
   =========================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Palette = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_RATIO = 3.0;          // contrast floor for a dark module's mean
  var TONE_FLOOR = 2.0;         // no single tone may be lighter than this

  /* WHAT ACTUALLY HAS TO CLEAR THE FLOOR is a module's area-weighted mean, not
     every individual face. A scanner thresholds a module; it never sees a
     voxel. Holding each surface at or above MIN_RATIO is stricter than
     scanning requires, and it is what collapsed the canopy to a single tone:
     any lighter variant got darkened straight back to the floor, leaving
     nothing to dapple with. Uniform tone across a lattice of cubes is exactly
     what reads as stacked bricks.

     So there are two rules, not one:

       SUB-MODULE surfaces (leaves) may use a tone ladder whose weighted MEAN
       clears MIN_RATIO. Individual rungs may sit below it - the reference's
       own code view mixes tones at 2.07:1, 2.53:1 and 3.21:1 and still
       decodes - but none may go lighter than TONE_FLOOR, so a run of
       highlights inside one module cannot lift it over.

       WHOLE-MODULE surfaces (grass, soil, bark) keep the per-surface floor
       exactly as before. One block covers one module, so there is no
       averaging to rely on and every tone must clear MIN_RATIO by itself. */

  // --- colour maths ------------------------------------------------------
  function parseHex(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function toHex(rgb) {
    return '#' + rgb.map(function (v) {
      var c = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return c.length === 1 ? '0' + c : c;
    }).join('');
  }

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function luminance(hex) {
    var p = parseHex(hex);
    return 0.2126 * srgbToLinear(p[0]) + 0.7152 * srgbToLinear(p[1]) + 0.0722 * srgbToLinear(p[2]);
  }

  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    var hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Multiply toward black. Only ever used on dark-module surfaces.
  function darken(hex, amount) {
    var p = parseHex(hex);
    var k = 1 - amount;
    return toHex([p[0] * k, p[1] * k, p[2] * k]);
  }

  // Blend toward white. Only ever used on paving.
  function lighten(hex, amount) {
    var p = parseHex(hex);
    return toHex([
      p[0] + (255 - p[0]) * amount,
      p[1] + (255 - p[1]) * amount,
      p[2] + (255 - p[2]) * amount
    ]);
  }

  /* Darken until the colour clears the floor against `paving`. Returns the
     colour plus whether it had to move, so the UI/tests can report which
     choices the contrast floor overrode rather than silently "fixing" them. */
  function enforceContrast(hex, paving, minRatio) {
    minRatio = minRatio || MIN_RATIO;
    var out = hex, steps = 0;
    while (contrast(out, paving) < minRatio && steps < 60) {
      out = darken(out, 0.05);
      steps++;
    }
    return { hex: out, forced: steps > 0, steps: steps, ratio: contrast(out, paving) };
  }

  // --- ground ------------------------------------------------------------
  // Paving is the light module and also the canvas background, so the 4-module
  // quiet zone is the same colour as the light paving and reads as margin.
  var PAVING = '#EDEAE3';
  /* Ground sits just above the 3:1 floor, not the near-black 10:1 it is
     tempting to reach for. The ground layer alone reproduces the matrix, so
     the instinct is to make it as dark as possible - but every stop past the
     floor is headroom spent on nothing, and a dark floor competes with the
     tree. The plot should recede as a plaza, not read as a second pattern
     fighting the canopy.

     Soil and grass also sit close to each other in weight. Two ground tones of
     clearly different lightness make the floor read as a busy checkerboard;
     near-equal luminance lets it read as one surface with variation in it. */
  var SOIL = '#8d826e';        // warm stone, 3.15:1
  var GRASS = '#698d57';       // 3.15:1
  var SLAB_SIDE = '#6E6152';  // never seen from overhead

  /* Six foliage swatches, each sitting just above MIN_RATIO rather than well
     past it.

     HOW THESE WERE PICKED, because the obvious method produces mud. Taking a
     pastel and darkening it toward black until it clears the floor also drains
     its saturation: #F8C8DC treated that way lands on #947884, a grey mauve
     that reads as dead wine rather than blossom. The multiply is the problem -
     it scales all three channels together, so chroma collapses along with
     luminance.

     Instead each swatch is a SATURATED hue chosen AT the target luminance:
     fix hue and saturation, then solve lightness for the ratio. That keeps the
     colour vivid at 3.2:1 where the darkened version was muddy at 5.4:1.

     `wanted` keeps the pastel a designer would reach for, so the report can
     still show what the floor rules out. */
  var SWATCHES = [
    { id: 'rose', name: 'Rose', wanted: '#F8C8DC', hex: '#c1647d' },
    { id: 'jade', name: 'Jade', wanted: '#7BC47F', hex: '#4b8f5b' },
    { id: 'amber', name: 'Amber', wanted: '#F2B441', hex: '#9c7c51' },
    { id: 'indigo', name: 'Indigo', wanted: '#8FA8DE', hex: '#6182ba' },
    { id: 'plum', name: 'Plum', wanted: '#C79BE0', hex: '#ae64c0' },
    { id: 'moss', name: 'Moss', wanted: '#AFC46B', hex: '#738947' }
  ];

  /* Leaf tone ladder: offsets from the base (positive lightens) and the share
     of voxels each takes. Sub-module, so the weighted mean is what matters. */
  /* The ladder is asymmetric: capped at +0.13 on the light side, running to
     -0.32 on the dark. A symmetric +/-0.26 ladder looks better in isolation
     but its highlight rung crosses the threshold the matrix-reconstruction
     test samples at, on four of the six swatches - and that test duly caught
     it, 12 modules flipping light. ZBar still read those codes, because real
     scanners threshold locally; the fixed-threshold test is the stricter
     canary and is worth keeping strict.

     Weights were then solved so the area-weighted mean is unchanged despite
     the asymmetry - it drifts by at most 0.009 across the six swatches. */
  var LEAF_LADDER = [
    { d: 0.13, w: 0.14 },   // highlight
    { d: 0.065, w: 0.24 },  // light
    { d: 0.00, w: 0.44 },   // base
    { d: -0.16, w: 0.12 },  // shade
    { d: -0.32, w: 0.06 }   // deep
  ];
  // Narrower, and every rung must clear the floor on its own.
  var GROUND_LADDER = [
    { d: 0.05, w: 0.28 },
    { d: 0.00, w: 0.40 },
    { d: -0.10, w: 0.32 }
  ];

  // Per-species surfaces that are not the swatch colour.
  var SPECIES_COLOURS = {
    sakura: { barkTop: '#4A3328', barkSide: '#7A5A46' },
    oak:    { barkTop: '#3E2F22', barkSide: '#6B513A' },
    // The gum is the reason side faces are worth treating separately: a dark
    // top face keeps the code alive while near-white sides read as the pale
    // ribboned bark the tree is known for.
    gum:    { barkTop: '#413B30', barkSide: '#E4DED2' },
    willow: { barkTop: '#3A3B2E', barkSide: '#6E6A55' }
  };

  /* Build the full colour set for a species + swatch, with every dark-module
     surface pushed through the contrast floor. */
  function build(speciesId, swatchId) {
    var swatch = SWATCHES.filter(function (s) { return s.id === swatchId; })[0] || SWATCHES[0];
    var sp = SPECIES_COLOURS[speciesId] || SPECIES_COLOURS.oak;
    var forced = [];

    function gate(label, hex) {
      var r = enforceContrast(hex, PAVING);
      if (r.forced) forced.push({ label: label, from: hex, to: r.hex, ratio: r.ratio });
      return r.hex;
    }

    var pal = {
      paving: PAVING,
      soil: gate('soil', SOIL),
      slabSide: SLAB_SIDE,
      foliageTop: gate('foliage', swatch.hex),
      barkTop: gate('bark', sp.barkTop),
      barkSide: sp.barkSide,          // side face: exempt from the floor
      grassTop: gate('grass', GRASS),
      swatch: swatch,
      forced: forced
    };
    /* Side shading. Two tones per material, one per visible side face, so the
       3-D view reads as volume.

       Sides go DARKER than the top, which is the opposite of the first thing
       you would try. The contrast floor has already forced every top face to
       be dark; if the sides are then made lighter, every leaf reads as a dark
       cap on a pale stalk and the crown looks like a field of mushrooms. Since
       side faces are exempt from the floor, shading them down instead restores
       ordinary top-lit form for free. The gum is the exception - its pale bark
       is the whole point, so it keeps light sides. */
    function sides(top, a, b) {
      return { top: top, sideA: darken(top, a), sideB: darken(top, b) };
    }
    pal.mat = {
      leaf: sides(pal.foliageTop, 0.16, 0.32),
      grass: sides(pal.grassTop, 0.16, 0.32),
      soil: sides(pal.soil, 0.16, 0.32),
      bark: { top: pal.barkTop, sideA: pal.barkSide, sideB: darken(pal.barkSide, 0.16) }
    };

    /* Tone ladders. Every leaf carrying one colour is what makes a crown read
       as a grid of identical bricks rather than a mass of foliage; the
       reference has roughly 24 tone families against our 4. Weights are chosen
       so the area-weighted mean luminance is unchanged - the module is exactly
       as dark as it was, it simply is not flat. */
    pal.mat.leaf.ladder = LEAF_LADDER.map(function (r) {
      var hex = r.d > 0 ? lighten(pal.foliageTop, r.d) : darken(pal.foliageTop, -r.d);
      return { top: hex, sideA: darken(hex, 0.16), sideB: darken(hex, 0.32), w: r.w };
    });
    /* Ground blocks cover a whole module each, so their rungs stay above the
       per-surface floor and the spread is deliberately narrow. */
    ['grass', 'soil'].forEach(function (k) {
      var baseHex = k === 'grass' ? pal.grassTop : pal.soil;
      pal.mat[k].ladder = GROUND_LADDER.map(function (r) {
        var hex = r.d > 0 ? lighten(baseHex, r.d) : darken(baseHex, -r.d);
        hex = enforceContrast(hex, PAVING).hex;      // whole-module: hard floor
        return { top: hex, sideA: darken(hex, 0.16), sideB: darken(hex, 0.32), w: r.w };
      });
    });

    /* Fallen blossom. Ground under the crown is carpeted with these rather
       than left as bare soil: leaf cubes are smaller than their module, so
       from overhead the gaps would show brown and the crown would read as
       speckle on dirt instead of a solid block of colour. Both tones are
       DARKER than the leaves above them, so they clear the floor by more
       than the foliage does - the carpet costs nothing in contrast.

       Together with the two side tones this is the five-tone ladder:
         top 0   right -16%   fallen -24%   left -32%   fallen2 -34%  */
    /* Kept close to the foliage rather than well below it. The point of the
       carpet is that a crown module reads SOLID from overhead - leaf cube
       where there is a leaf, fallen petal where there is not, in one colour.
       Pushing the carpet far darker reintroduced it as a third weight on the
       floor competing with the tree. */
    pal.mat.fallen = sides(darken(pal.foliageTop, 0.08), 0.16, 0.32);
    pal.mat.fallen2 = sides(darken(pal.foliageTop, 0.16), 0.16, 0.32);
    pal.foliageSide = pal.mat.leaf.sideA;
    pal.grassSide = pal.mat.grass.sideA;
    pal.soilSide = darken(pal.soil, 0.10);
    return pal;
  }

  // Report every top-face colour against the floor. Used by the test harness
  // and by the in-page contrast readout.
  // Area-weighted mean contrast of a ladder against the paving.
  function ladderMeanRatio(rungs) {
    var L = 0, W = 0;
    for (var i = 0; i < rungs.length; i++) {
      L += luminance(rungs[i].top) * rungs[i].w;
      W += rungs[i].w;
    }
    return (luminance(PAVING) + 0.05) / (L / W + 0.05);
  }

  function audit() {
    var rows = [];
    function add(label, hex, exempt) {
      rows.push({
        label: label, hex: hex, ratio: contrast(hex, PAVING),
        pass: exempt || contrast(hex, PAVING) >= MIN_RATIO, exempt: !!exempt
      });
    }
    add('paving (reference)', PAVING, true);
    add('soil', SOIL);
    add('grass', GRASS);
    SWATCHES.forEach(function (s) {
      add('foliage ' + s.name, s.hex);
      rows.push({
        label: 'foliage ' + s.name + ' (natural choice, rejected)',
        hex: s.wanted, ratio: contrast(s.wanted, PAVING),
        pass: contrast(s.wanted, PAVING) >= MIN_RATIO, rejected: true
      });
    });
    Object.keys(SPECIES_COLOURS).forEach(function (k) {
      add(k + ' bark top', SPECIES_COLOURS[k].barkTop);
      add(k + ' bark side (side face, exempt)', SPECIES_COLOURS[k].barkSide, true);
    });
    /* Ladder checks. Leaves are judged on their weighted mean, with a
       per-tone backstop; ground ladders are judged per rung. */
    SWATCHES.forEach(function (sw) {
      var pal = build('sakura', sw.id);
      var mean = ladderMeanRatio(pal.mat.leaf.ladder);
      var lightest = Math.min.apply(null, pal.mat.leaf.ladder.map(function (r) {
        return contrast(r.top, PAVING);
      }));
      rows.push({
        label: 'leaf ladder ' + sw.name + ' (weighted mean of 5 tones)',
        hex: pal.mat.leaf.top, ratio: mean, pass: mean >= MIN_RATIO, ladder: true
      });
      rows.push({
        label: 'leaf ladder ' + sw.name + ' lightest tone (backstop ' + TONE_FLOOR + ':1)',
        hex: pal.mat.leaf.ladder[0].top, ratio: lightest,
        pass: lightest >= TONE_FLOOR, ladder: true
      });
    });
    var gp = build('sakura', 'rose');
    ['grass', 'soil'].forEach(function (k) {
      gp.mat[k].ladder.forEach(function (r, i) {
        rows.push({
          label: k + ' ladder rung ' + i + ' (whole module: hard floor)',
          hex: r.top, ratio: contrast(r.top, PAVING),
          pass: contrast(r.top, PAVING) >= MIN_RATIO
        });
      });
    });
    return rows;
  }

  return {
    MIN_RATIO: MIN_RATIO,
    TONE_FLOOR: TONE_FLOOR,
    ladderMeanRatio: ladderMeanRatio,
    PAVING: PAVING,
    SOIL: SOIL,
    SWATCHES: SWATCHES,
    SPECIES_COLOURS: SPECIES_COLOURS,
    luminance: luminance,
    contrast: contrast,
    darken: darken,
    lighten: lighten,
    enforceContrast: enforceContrast,
    build: build,
    audit: audit
  };
});
