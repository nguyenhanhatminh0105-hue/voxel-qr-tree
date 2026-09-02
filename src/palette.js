/* ===========================================================================
   palette.js - colour, and the contrast floor that governs it.

   The whole diorama is a QR code seen from above, so every surface that can
   land on a dark module competes with the paving for a scanner's attention.
   WCAG-style relative luminance contrast is the working proxy: anything that
   can sit over a dark module must clear MIN_RATIO against the paving colour.

   That floor is not a style guide, it is a hard constraint, and it forces
   colours well below what looks natural on screen. Pastel sakura pink is
   about 1.9:1 against pale paving and simply will not scan; the sakura here
   is a deep rose because arithmetic says so, not because anyone preferred it.

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

  var MIN_RATIO = 3.0;          // contrast floor for anything over a dark module

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
  var SOIL = '#3B342B';       // dark module. Comfortably past the floor: the
                              // ground layer alone reproduces the matrix, so it
                              // is the single most important contrast in the scene.
  var SLAB_SIDE = '#6E6152';  // never seen from overhead

  /* Six foliage swatches. Every one of these is darker than its natural-looking
     counterpart because it has to clear MIN_RATIO on its top face. The `wanted`
     field records the colour a designer would reach for, so the report can show
     exactly how far the floor pushed each one. */
  var SWATCHES = [
    { id: 'rose', name: 'Rose', wanted: '#F8C8DC', hex: '#9E3B58' },
    { id: 'jade', name: 'Jade', wanted: '#7BC47F', hex: '#2F6B3C' },
    { id: 'amber', name: 'Amber', wanted: '#F2B441', hex: '#8A5312' },
    { id: 'indigo', name: 'Indigo', wanted: '#8FA8DE', hex: '#3A4A7C' },
    { id: 'plum', name: 'Plum', wanted: '#C79BE0', hex: '#5D3570' },
    { id: 'moss', name: 'Moss', wanted: '#AFC46B', hex: '#4A5A22' }
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

  var GRASS = '#3F5A2E';

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
      leaf: sides(pal.foliageTop, 0.18, 0.34),
      grass: sides(pal.grassTop, 0.16, 0.30),
      bark: { top: pal.barkTop, sideA: pal.barkSide, sideB: darken(pal.barkSide, 0.16) }
    };
    pal.foliageSide = pal.mat.leaf.sideA;
    pal.grassSide = pal.mat.grass.sideA;
    pal.soilSide = darken(pal.soil, 0.10);
    return pal;
  }

  // Report every top-face colour against the floor. Used by the test harness
  // and by the in-page contrast readout.
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
    return rows;
  }

  return {
    MIN_RATIO: MIN_RATIO,
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
