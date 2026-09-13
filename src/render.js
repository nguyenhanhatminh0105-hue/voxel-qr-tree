/* ===========================================================================
   render.js - axonometric voxel renderer on canvas 2D.

   ORIGIN CONVENTION (read before touching the slab): world coordinates are
   module units, and every box is given by its MINIMUM corner plus extents.
   There is no implicit half-module shift anywhere in this file. The full-plot
   slab is therefore exactly (0, 0) to (n, n). If a -0.5 shift is ever added to
   the drawing code, the slab's own x/y must cancel it, or the slab juts past
   two edges of the plot and eats into the quiet zone.

   DRAW ORDER, and why it is not one sorted list:
     1. Canvas is flooded with the paving colour, so the quiet zone is light.
     2. The base slab is drawn FIRST, outside the sort. It spans the whole plot
        and sits under every block, so no single depth key can order it against
        them - a centre-point key puts it in the middle of the run and it
        paints over the back half of the ground.
     3. Steps 1-2 are cached to an offscreen canvas and redrawn only when the
        camera or palette changes. Wind forces a full repaint of the sorted
        list every frame, so the cache still earns its place.
     4. Everything else - including the dark modules, which are raised blocks
        rather than flat tiles - is depth sorted and painted back to front.
        Raised blocks genuinely overlap what stands on them, so unlike flat
        tiles they cannot be painted wholesale ahead of the sort.

   WIND: amplitude is scaled by (1 - t)^2, so it reaches exactly zero in the
   code view - any horizontal sway there would slide leaves off their modules
   and break the code. Each voxel is SHEARED between its base and its top
   rather than translated, so trees bend instead of sliding. Displacement grows
   as height^1.4 with a per-voxel phase hashed from position.
   =========================================================================== */
(function (root, factory) {
  var api = factory(typeof require === 'function' ? require('./palette.js') : root.Palette);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Render = api;
})(typeof self !== 'undefined' ? self : this, function (Palette) {
  'use strict';

  var DEG = Math.PI / 180;
  var YAW_START = 45 * DEG, YAW_END = 0;
  // atan(1/sqrt(2)) is the true isometric elevation, where the three axes
  // foreshorten equally.
  var PITCH_START = Math.atan(1 / Math.SQRT2), PITCH_END = 90 * DEG;
  var QUIET = 4;                  // modules of quiet zone in the code view
  var SLAB_BOTTOM = -1.5, SLAB_TOP = -0.02;   // slab spans these, in module units
  var EPS_FACE = 1e-6;            // below this a face is edge-on: do not draw
  var EPS_AREA = 1e-4;            // projected area floor, catches degenerate quads
  var WIND_FREQ = 0.0011;
  // Displacement in modules at the crown top, for a leaf (stiffness 1).
  var WIND_AMP = 0.50;
  var WIND_DIR = [0.82, 0.57];

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* --- camera ------------------------------------------------------------
     `e` is eased flip progress in [0, 1]. At e = 1 the yaw and the pitch
     cosine are snapped to exact zero rather than left as 6e-17, so the code
     view is exactly a plan view and the wind term is exactly zero. */
  function makeCamera(n, maxZ, e, W, H) {
    var atEnd = e >= 1;
    var yaw = atEnd ? 0 : YAW_START + (YAW_END - YAW_START) * e;
    var pitch = atEnd ? PITCH_END : PITCH_START + (PITCH_END - PITCH_START) * e;
    var cy = atEnd ? 1 : Math.cos(yaw);
    var sy = atEnd ? 0 : Math.sin(yaw);
    var cp = atEnd ? 0 : Math.cos(pitch);
    var sp = atEnd ? 1 : Math.sin(pitch);

    // Projected bounds of the scene's bounding volume, at unit scale.
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < 8; i++) {
      var x = (i & 1) ? n : 0;
      var y = (i & 2) ? n : 0;
      var z = (i & 4) ? maxZ : SLAB_BOTTOM;
      var vx = x * cy - y * sy;
      var vy = x * sy + y * cy;
      var px = vx, py = vy * sp - z * cp;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    var extent = Math.max(maxX - minX, maxY - minY);
    // Margin lands on exactly QUIET modules at e = 1, where extent is exactly n.
    var margin = 2 + (QUIET - 2) * e;
    var scale = Math.min(W, H) / (extent + margin * 2);

    return {
      e: e, yaw: yaw, pitch: pitch, cy: cy, sy: sy, cp: cp, sp: sp,
      scale: scale,
      ox: W / 2 - (minX + maxX) / 2 * scale,
      oy: H / 2 - (minY + maxY) / 2 * scale,
      n: n,
      // Only the top face survives a plan view; both side normals go edge-on.
      showSideY: cy * cp > EPS_FACE,
      showSideX: sy * cp > EPS_FACE
    };
  }

  function projX(cam, x, y) { return (x * cam.cy - y * cam.sy) * cam.scale + cam.ox; }
  function projY(cam, x, y, z) {
    return ((x * cam.sy + y * cam.cy) * cam.sp - z * cam.cp) * cam.scale + cam.oy;
  }

  /* Horizontal displacement of the wind field.

     `sway` is precomputed per voxel end in scene.js: stiffness x (z/maxZ)^1.4.
     Keeping the law there means both renderers obey it rather than each
     reimplementing pow(z, 1.4), and normalising by maxZ makes the sway a
     fraction of tree height so a big code does not get a windier tree.
     Ground blocks carry stiffness 0, so the ground never moves and the cache
     stays valid. Returns exactly 0 when amp is 0. */
  function windAt(sway, phase, time, amp) {
    if (amp === 0) return 0;
    return amp * sway * Math.sin(time * WIND_FREQ + phase);
  }

  function shoelace(pts) {
    var a = 0;
    for (var i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      a += (pts[j] * pts[i + 1]) - (pts[i] * pts[j + 1]);
    }
    return a / 2;
  }

  /* Collect the drawable faces of one box as flat [x0,y0,x1,y1,...] arrays.
     Exposed (via collectFaces) so the test harness can sweep every link x
     species x swatch combination for malformed geometry without rasterising. */
  function ring(out, cx, cy, rx, ry, n) {
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      out.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
    return out;
  }

  /* Emit the drawable faces of one voxel. Dispatches on shape: the reference
     is not a voxel renderer, so bark is a cylinder, blossom a rounded blob,
     grass a splayed blade and ground a flat tile. The canvas build
     approximates each with polygons - a ten-gon reads as round at these
     scales - while the WebGL build uses real solids. Both agree on the only
     thing the code depends on: what a module looks like from overhead. */
  function boxFaces(out, cam, v, time, amp) {
    var bd = windAt(v.swayLo || 0, v.phase, time, amp);
    var td = windAt(v.swayHi || 0, v.phase, time, amp);
    var bx = bd * WIND_DIR[0], by = bd * WIND_DIR[1];
    var tx = td * WIND_DIR[0] + (v.leanX || 0), ty = td * WIND_DIR[1] + (v.leanY || 0);

    var x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.d;
    var zb = v.z, zt = v.z + v.h;
    var shape = v.shape || 'box';

    if (shape === 'tile') {
      // flat ground: the top surface is all there is
      out.push({ pts: [
        projX(cam, x0, y0), projY(cam, x0, y0, zt),
        projX(cam, x1, y0), projY(cam, x1, y0, zt),
        projX(cam, x1, y1), projY(cam, x1, y1, zt),
        projX(cam, x0, y1), projY(cam, x0, y1, zt)
      ], col: v.top });
      return;
    }

    if (shape === 'blob') {
      // a sphere projects to a circle under an orthographic camera
      var mcx = (x0 + x1) / 2 + tx, mcy = (y0 + y1) / 2 + ty, mcz = (zb + zt) / 2;
      var px = projX(cam, mcx, mcy), py = projY(cam, mcx, mcy, mcz);
      var r = v.w / 2 * cam.scale;
      out.push({ pts: ring([], px, py, r, r, 10), col: v.sideA || v.side });
      // a smaller disc offset up-sun keeps the audited top tone facing the sky
      out.push({ pts: ring([], px - r * 0.16, py - r * 0.20, r * 0.74, r * 0.74, 10),
                 col: v.top });
      return;
    }

    if (shape === 'cyl') {
      // body, then an elliptical cap - no vertical edges, no jitter
      var cx0 = projX(cam, x0 + bx, (y0 + y1) / 2 + by);
      var cx1 = projX(cam, x1 + bx, (y0 + y1) / 2 + by);
      var byy = projY(cam, (x0 + x1) / 2 + bx, (y0 + y1) / 2 + by, zb);
      var tyy = projY(cam, (x0 + x1) / 2 + tx, (y0 + y1) / 2 + ty, zt);
      var tcx0 = projX(cam, x0 + tx, (y0 + y1) / 2 + ty);
      var tcx1 = projX(cam, x1 + tx, (y0 + y1) / 2 + ty);
      /* The body is a vertical surface, so it goes edge-on in the plan view.
         Emit it only when the camera can actually see it - the box path
         already gates its sides the same way, and a zero-area polygon is a
         geometry-sweep failure even though the painter skips it. */
      if (cam.cp > EPS_FACE) {
        out.push({ pts: [cx0, byy, cx1, byy, tcx1, tyy, tcx0, tyy], col: v.sideA || v.side });
      }
      var ccx = (tcx0 + tcx1) / 2, crx = (tcx1 - tcx0) / 2;
      /* A horizontal circle foreshortens by sin(pitch), not cos: it is a full
         circle looking straight down and squashed at isometric. Using cos had
         it exactly backwards - the cap collapsed to a zero-area line in the
         plan view, which is the one view the code is read from. */
      out.push({ pts: ring([], ccx, tyy, crx, crx * cam.sp, 10), col: v.top });
      return;
    }

    if (shape === 'blade') {
      // tapered spike leaning along its splay
      var ax = projX(cam, x0 + bx, y0 + by), ay = projY(cam, x0 + bx, y0 + by, zb);
      var b2x = projX(cam, x1 + bx, y1 + by), b2y = projY(cam, x1 + bx, y1 + by, zb);
      var tipx = projX(cam, (x0 + x1) / 2 + tx, (y0 + y1) / 2 + ty);
      var tipy = projY(cam, (x0 + x1) / 2 + tx, (y0 + y1) / 2 + ty, zt);
      // a blade with no splay is edge-on from directly overhead
      var ar = Math.abs((b2x - ax) * (tipy - ay) - (tipx - ax) * (b2y - ay)) / 2;
      if (ar > EPS_AREA) out.push({ pts: [ax, ay, b2x, b2y, tipx, tipy], col: v.top });
      return;
    }

    // top face - always visible, and the only face that survives the plan view
    var top = [
      projX(cam, x0 + tx, y0 + ty), projY(cam, x0 + tx, y0 + ty, zt),
      projX(cam, x1 + tx, y0 + ty), projY(cam, x1 + tx, y0 + ty, zt),
      projX(cam, x1 + tx, y1 + ty), projY(cam, x1 + tx, y1 + ty, zt),
      projX(cam, x0 + tx, y1 + ty), projY(cam, x0 + tx, y1 + ty, zt)
    ];
    if (cam.showSideY) {
      out.push({ pts: [
        projX(cam, x0 + bx, y0 + by), projY(cam, x0 + bx, y0 + by, zb),
        projX(cam, x1 + bx, y0 + by), projY(cam, x1 + bx, y0 + by, zb),
        projX(cam, x1 + tx, y0 + ty), projY(cam, x1 + tx, y0 + ty, zt),
        projX(cam, x0 + tx, y0 + ty), projY(cam, x0 + tx, y0 + ty, zt)
      ], col: v.sideA || v.side });
    }
    if (cam.showSideX) {
      out.push({ pts: [
        projX(cam, x0 + bx, y0 + by), projY(cam, x0 + bx, y0 + by, zb),
        projX(cam, x0 + bx, y1 + by), projY(cam, x0 + bx, y1 + by, zb),
        projX(cam, x0 + tx, y1 + ty), projY(cam, x0 + tx, y1 + ty, zt),
        projX(cam, x0 + tx, y0 + ty), projY(cam, x0 + tx, y0 + ty, zt)
      ], col: v.sideB || v.side });
    }
    out.push({ pts: top, col: v.top });
  }

  // Depth key. The far corner in plan, and the TOP of the box in z: in the
  // plan view the visible surface is the top face, so the box whose top is
  // highest must be painted last.
  function depthKey(cam, v) {
    var vy = (v.x + v.w) * cam.sy + (v.y + v.d) * cam.cy;
    return vy * cam.cp - (v.z + v.h) * cam.sp;
  }

  function fillPoly(ctx, pts, col) {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.fill();
  }

  /* Ground: background flood, slab, paving, dark tiles. Nothing here moves in
     the wind and nothing here overlaps, so the whole thing is one cacheable
     image. */
  function drawGround(ctx, scene, cam, W, H) {
    var pal = scene.palette, n = scene.n;
    ctx.save();
    ctx.fillStyle = pal.paving;
    ctx.fillRect(0, 0, W, H);

    /* --- slab, first and outside the sort -------------------------------
       It spans the whole plot and sits under every block, so no single depth
       key can order it against them - a centre-point key puts it in the middle
       of the run and it paints over the back half of the ground.

       Exactly (0,0)-(n,n): no half-module shift is applied anywhere in this
       file. If one is ever added, the slab's own x/y must cancel it or the
       slab juts past two edges and eats the quiet zone.

       The dark modules themselves are NOT drawn here. They are raised blocks,
       which genuinely overlap what stands on them, so they live in the sorted
       voxel list like everything else. That leaves this cache holding just the
       background flood and one box - still worth keeping, since wind forces a
       full repaint of the sorted list every frame. */
    var slab = { x: 0, y: 0, z: SLAB_BOTTOM, w: n, d: n, h: SLAB_TOP - SLAB_BOTTOM,
                 phase: 0, top: pal.paving, side: pal.slabSide,
                 sideA: pal.slabSide, sideB: Palette.darken(pal.slabSide, 0.14) };
    var faces = [];
    boxFaces(faces, cam, slab, 0, 0);
    for (var f = 0; f < faces.length; f++) {
      if (Math.abs(shoelace(faces[f].pts)) > EPS_AREA) fillPoly(ctx, faces[f].pts, faces[f].col);
    }

    ctx.restore();
  }

  // Faces of every standing voxel, depth sorted, ready to paint.
  function collectFaces(scene, cam, time, amp) {
    var vox = scene.voxels;
    var order = new Array(vox.length);
    for (var i = 0; i < vox.length; i++) order[i] = i;
    order.sort(function (a, b) { return depthKey(cam, vox[b]) - depthKey(cam, vox[a]); });

    var faces = [];
    for (var k = 0; k < order.length; k++) boxFaces(faces, cam, vox[order[k]], time, amp);
    return faces;
  }

  function drawVoxels(ctx, scene, cam, time, amp) {
    var faces = collectFaces(scene, cam, time, amp);
    for (var i = 0; i < faces.length; i++) {
      var f = faces[i];
      if (Math.abs(shoelace(f.pts)) <= EPS_AREA) continue;   // edge-on or degenerate
      fillPoly(ctx, f.pts, f.col);
    }
    return faces.length;
  }

  /* The stage carries cursor:pointer and a click handler but was tabIndex -1,
     so the on-screen hint instructed a gesture keyboard users could not
     perform. This gives it focus and a key path without changing the camera. */
  function attachStageKeys(el, onTap) {
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label',
      'Voxel tree. Press Enter to flip between the tree and the scannable code.');
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { onTap(); ev.preventDefault(); }
    });
  }

  /* Ambient life. Both renderers read these so the two builds agree on what
     the weather is doing; each draws it with its own primitives.

     Fall is expressed as descents per second: the old 0.6-1.7 meant a petal
     crossed the whole scene in well under two seconds, which read as rain
     rather than drift. Winter is snow - slower, larger, and it wanders. */
  /* kind drives the silhouette, and each one is its season: a cherry petal,
     a winged samara, a ginkgo fan, a six-spoke flake. SPECIES already declared
     these (petals / seeds / leaves / snow) and the renderers were drawing a
     square for three of the four. Counts come down as the sizes go up - the
     brief is a moderate amount of weather, not a blizzard. */
  var WEATHER = {
    sakura:  { kind: 'petal', fall: 0.13, spread: 0.10, size: 0.98, sway: 0.9, count: 54, snow: false },
    oak:     { kind: 'seed',  fall: 0.17, spread: 0.12, size: 0.90, sway: 1.2, count: 46, snow: false },
    ginkgo:  { kind: 'leaf',  fall: 0.15, spread: 0.11, size: 1.08, sway: 1.4, count: 50, snow: false },
    willow:  { kind: 'flake', fall: 0.10, spread: 0.07, size: 1.02, sway: 1.7, count: 66, snow: true }
  };
  /* Snow has to read against the paving, which is itself pale and warm
     (#edeae3). Near-white snow was invisible on it. A cool blue-grey
     separates by temperature rather than by lightness. */
  var SNOW_TINT = '#c3d1de';

  function weatherFor(species) { return WEATHER[species] || WEATHER.sakura; }

  /* One shape definition, both renderers. The canvas build calls this per
     particle; the WebGL build paints it once into an offscreen canvas and uses
     that as the point sprite, so the two builds cannot drift apart.
     Draws into a box of side `s` centred on (cx, cy). The caller sets
     fillStyle and strokeStyle. */
  function paintFallShape(ctx, kind, cx, cy, s, rot) {
    var r = s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    if (kind === 'cap') {
      // a soft mound, wider than tall: snow lying on a leaf
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 0.98, r * 0.56, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (kind === 'flake') {
      ctx.lineWidth = Math.max(1, s * 0.15);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (var i = 0; i < 3; i++) {
        var a = i * Math.PI / 3;
        ctx.moveTo(-Math.cos(a) * r, -Math.sin(a) * r);
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      // short barbs, which is what separates a flake from an asterisk
      for (var j = 0; j < 6; j++) {
        var b = j * Math.PI / 3, bx = Math.cos(b) * r * 0.62, by = Math.sin(b) * r * 0.62;
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(b + 0.9) * r * 0.28, by + Math.sin(b + 0.9) * r * 0.28);
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(b - 0.9) * r * 0.28, by + Math.sin(b - 0.9) * r * 0.28);
      }
      ctx.stroke();
    } else if (kind === 'leaf') {
      // ginkgo: a fan, notched at the crown, on a short stalk
      ctx.beginPath();
      ctx.moveTo(0, r * 0.96);
      ctx.quadraticCurveTo(-r * 0.98, r * 0.18, -r * 0.66, -r * 0.74);
      ctx.quadraticCurveTo(-r * 0.22, -r * 0.46, 0, -r * 0.58);
      ctx.quadraticCurveTo(r * 0.22, -r * 0.46, r * 0.66, -r * 0.74);
      ctx.quadraticCurveTo(r * 0.98, r * 0.18, 0, r * 0.96);
      ctx.fill();
    } else if (kind === 'seed') {
      // samara: a seed body with one wing, the thing that spins as it falls
      ctx.beginPath();
      ctx.ellipse(0, r * 0.46, r * 0.32, r * 0.27, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, r * 0.34);
      ctx.quadraticCurveTo(r * 0.88, -r * 0.10, r * 0.22, -r * 0.96);
      ctx.quadraticCurveTo(-r * 0.06, -r * 0.18, 0, r * 0.34);
      ctx.fill();
    } else {
      // cherry petal: rounded, with the characteristic notch at the tip
      ctx.beginPath();
      ctx.moveTo(0, r * 0.92);
      ctx.bezierCurveTo(-r * 1.0, r * 0.40, -r * 0.82, -r * 0.58, -r * 0.16, -r * 0.90);
      ctx.quadraticCurveTo(0, -r * 0.62, r * 0.16, -r * 0.90);
      ctx.bezierCurveTo(r * 0.82, -r * 0.58, r * 1.0, r * 0.40, 0, r * 0.92);
      ctx.fill();
    }
    ctx.restore();
  }

  /* Birds: a few crossing the sky on slow circular arcs, well above the crown
     and outside the plot footprint, so they stay small disconnected blobs that
     the silhouette measurement discards. Deterministic in `time` - no state,
     so both renderers and the test harness agree frame for frame. */
  var BIRD_COUNT = 3;
  var BIRD_PERIOD = 26000;        // ms for a full circuit
  var BIRD_SPAN = 0.62;           // orbit radius, as a fraction of plot width

  function birdsAt(n, maxZ, time) {
    var out = [];
    for (var i = 0; i < BIRD_COUNT; i++) {
      var ph = (time / BIRD_PERIOD + i / BIRD_COUNT) * Math.PI * 2;
      var r = n * BIRD_SPAN * (0.82 + 0.18 * Math.sin(ph * 0.7 + i));
      out.push({
        x: n / 2 + Math.cos(ph) * r,
        y: n / 2 + Math.sin(ph) * r * 0.72,
        z: maxZ + n * (0.30 + 0.10 * Math.sin(ph * 1.7 + i * 2)),
        // wing phase drives the V opening; a flat V reads as a glide
        flap: Math.sin(time / 190 + i * 1.7),
        dir: Math.cos(ph) >= 0 ? 1 : -1
      });
    }
    return out;
  }

  return {
    attachStageKeys: attachStageKeys,
    weatherFor: weatherFor, birdsAt: birdsAt, SNOW_TINT: SNOW_TINT,
    paintFallShape: paintFallShape,
    BIRD_COUNT: BIRD_COUNT,
    DEG: DEG, QUIET: QUIET, SLAB_BOTTOM: SLAB_BOTTOM, SLAB_TOP: SLAB_TOP,
    WIND_AMP: WIND_AMP, WIND_FREQ: WIND_FREQ, WIND_DIR: WIND_DIR,
    EPS_AREA: EPS_AREA,
    easeInOutCubic: easeInOutCubic,
    makeCamera: makeCamera,
    projX: projX, projY: projY,
    windAt: windAt,
    shoelace: shoelace,
    boxFaces: boxFaces,
    depthKey: depthKey,
    collectFaces: collectFaces,
    drawGround: drawGround,
    drawVoxels: drawVoxels,
    fillPoly: fillPoly
  };
});
