/* ===========================================================================
   app.js - UI, animation, export.
   =========================================================================== */
(function () {
  'use strict';

  var DEFAULT_URL = 'https://github.com/nguyenhanhatminh0105-hue';
  var FLIP_MS = 950;

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var state = {
    text: DEFAULT_URL,
    species: 'sakura',
    swatch: null,      // null = use the species' own foliage colour
    t: 0,                  // raw flip progress 0..1
    target: 0,
    scene: null,
    qr: null,
    error: null
  };

  var canvas, ctx, dpr = 1, W = 0, H = 0;
  var ground = null, groundKey = '';
  var particles = [];
  var startTime = performance.now();

  // --- scene ------------------------------------------------------------
  function rebuild() {
    /* No silent fallback to DEFAULT_URL. An empty field used to render a
       finished, exportable code for somebody else's link while the placeholder
       implied otherwise. */
    if (!state.text) {
      state.error = null;
      state.empty = true;
      updateReadout();
      return;
    }
    state.empty = false;
    try {
      state.qr = QR.encode(state.text, { ecl: 'M' });
      state.error = null;
    } catch (e) {
      state.error = e.message;
      updateReadout();
      return;
    }
    state.scene = Scene.build({
      matrix: state.qr.modules,
      seed: state.text,
      species: state.species,
      swatch: state.swatch
    });
    state.scene.id = [state.text, state.species, state.swatch].join('|');
    seedParticles();
    groundKey = '';
    updateReadout();
  }

  function seedParticles() {
    particles = [];
    if (reduceMotion) return;
    var n = state.scene.n, maxZ = state.scene.maxZ;
    var w = Render.weatherFor(state.species);
    var rnd = Scene.mulberry32(Scene.hashString(state.scene.id + '#p'));
    for (var i = 0; i < w.count; i++) {
      /* Debris stays over the plot: the weather belongs to the arboretum, not
         to the empty air around it. */
      particles.push({
        x: rnd() * n, y: rnd() * n,
        z: rnd() * maxZ,
        fall: w.fall + rnd() * w.spread,
        drift: rnd() * Math.PI * 2,
        size: w.size * (0.78 + rnd() * 0.48),
        spin: rnd() * Math.PI * 2,
        tumble: 0.5 + rnd() * 1.1,       // leaves turn as they fall
        top: maxZ
      });
    }
  }

  // --- drawing ----------------------------------------------------------
  function ensureGround(scene, cam) {
    var key = [scene.id, cam.e.toFixed(5), W, H, dpr].join('|');
    if (key === groundKey && ground) return ground;
    if (!ground) ground = document.createElement('canvas');
    if (ground.width !== canvas.width || ground.height !== canvas.height) {
      ground.width = canvas.width;
      ground.height = canvas.height;
    }
    var gctx = ground.getContext('2d');
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, W, H);
    Render.drawGround(gctx, scene, cam, W, H);
    groundKey = key;
    return ground;
  }

  function drawParticles(ctx2, scene, cam, time, fade) {
    if (fade <= 0 || reduceMotion) return;
    var maxZ = scene.maxZ, n = scene.n;
    var pal = scene.palette;
    var w = Render.weatherFor(state.species);
    ctx2.save();
    ctx2.globalAlpha = fade * (w.snow ? 0.92 : 0.85);
    ctx2.fillStyle = w.snow ? Render.SNOW_TINT : pal.foliageSide;
    ctx2.strokeStyle = ctx2.fillStyle;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      // fall and recycle; purely decorative, never touches the code
      var z = p.top - ((time * 0.001 * p.fall + p.drift) % 1) * (p.top + 1);
      var sway = Math.sin(time * 0.0016 + p.drift) * w.sway;
      var x = p.x + sway, y = p.y + sway * 0.4;
      if (x < 0 || y < 0 || x > n || y > n) continue;
      var sx = Render.projX(cam, x, y);
      var sy = Render.projY(cam, x, y, z);
      var s = p.size * cam.scale;
      Render.paintFallShape(ctx2, w.kind, sx, sy, s,
        p.spin + time * 0.00055 * p.tumble);
    }
    ctx2.restore();
  }

  /* Snow sitting on a winter canopy. Decorative only and faded with the
     weather - the leaf's top face is the audited surface the code is read
     from, so it can never actually be repainted white. */
  function drawSnowCaps(ctx2, scene, cam, fade) {
    if (fade <= 0 || reduceMotion) return;
    if (!Render.weatherFor(state.species).snow || !scene.crownTops) return;
    var caps = scene.crownTops;
    ctx2.save();
    ctx2.globalAlpha = fade * 0.8;
    ctx2.fillStyle = Render.SNOW_TINT;
    for (var i = 0; i < caps.length; i += 2) {
      var cp = caps[i];
      var sx = Render.projX(cam, cp.x + 0.5, cp.y + 0.5);
      var sy = Render.projY(cam, cp.x + 0.5, cp.y + 0.5, cp.z + 0.18);
      var sz = cam.scale;
      ctx2.beginPath();
      ctx2.ellipse(sx, sy, sz * 0.34, sz * 0.19, 0, 0, Math.PI * 2);
      ctx2.fill();
    }
    ctx2.restore();
  }

  /* Birds ride the same fade as the weather, so the sky is empty well before
     the matrix has to read. They stay outside the plot footprint and each one
     is far under 1% of the diorama's area, which is the threshold the
     silhouette measurement uses to discard things that are not the diorama. */
  function drawBirds(ctx2, scene, cam, time, fade) {
    if (fade <= 0 || reduceMotion) return;
    var birds = Render.birdsAt(scene.n, scene.maxZ, time);
    ctx2.save();
    ctx2.globalAlpha = fade * 0.6;
    ctx2.strokeStyle = scene.palette.soil;
    ctx2.lineWidth = Math.max(1, 0.055 * cam.scale);
    ctx2.lineCap = 'round';
    for (var i = 0; i < birds.length; i++) {
      var b = birds[i];
      var sx = Render.projX(cam, b.x, b.y);
      var sy = Render.projY(cam, b.x, b.y, b.z);
      var halfSpan = 0.40 * cam.scale;
      var lift = b.flap * 0.34 * halfSpan;
      ctx2.beginPath();
      ctx2.moveTo(sx - halfSpan, sy - lift);
      ctx2.lineTo(sx, sy);
      ctx2.lineTo(sx + halfSpan, sy - lift);
      ctx2.stroke();
    }
    ctx2.restore();
  }

  function frame() {
    var now = performance.now();
    var time = now - startTime;

    // advance the flip
    if (state.t !== state.target) {
      var step = (now - (frame.last || now)) / (reduceMotion ? 1 : FLIP_MS);
      if (state.target > state.t) state.t = Math.min(state.target, state.t + step);
      else state.t = Math.max(state.target, state.t - step);
    }
    frame.last = now;

    if (state.scene) {
      var e = Render.easeInOutCubic(state.t);
      var scene = state.scene;
      var cam = Render.makeCamera(scene.n, scene.maxZ, e, W, H);
      // (1 - t)^2: wind is exactly zero in the code view, so nothing has moved
      // off its module by the time the matrix has to read.
      var amp = reduceMotion ? 0 : Render.WIND_AMP * (1 - e) * (1 - e);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(ensureGround(scene, cam), 0, 0, W, H);
      Render.drawVoxels(ctx, scene, cam, time, amp);
      var ambient = Math.max(0, 1 - e / 0.6);
      drawSnowCaps(ctx, scene, cam, ambient);
      drawParticles(ctx, scene, cam, time, ambient);
      drawBirds(ctx, scene, cam, time, ambient);
    }
    requestAnimationFrame(frame);
  }

  // --- layout -----------------------------------------------------------
  function resize() {
    var rect = canvas.parentNode.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(240, Math.floor(rect.width));
    H = Math.max(240, Math.floor(rect.height));
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    groundKey = '';
  }

  // --- UI ---------------------------------------------------------------
  function updateReadout() {
    var scan = document.getElementById('scan');
    if (!scan) return;
    var wrap = document.getElementById('stagewrap');
    var png = document.getElementById('png');
    var invalid = !!(state.empty || state.error);
    if (wrap) wrap.classList.toggle('invalid', invalid);
    if (png) png.disabled = invalid;
    if (state.empty) {
      scan.className = 'scan err';
      scan.textContent = 'Type a link to plant it.';
      return;
    }
    if (state.error) {
      scan.className = 'scan err';
      scan.textContent = 'Cannot encode: ' + state.error;
      return;
    }
    /* Nothing to report: the diorama is the readout. */
    scan.className = 'scan';
    scan.textContent = '';
  }

  function exportPNG() {
    if (state.empty || state.error) return;
    var scale = 2;
    var off = document.createElement('canvas');
    off.width = W * scale; off.height = H * scale;
    var octx = off.getContext('2d');
    octx.setTransform(scale, 0, 0, scale, 0, 0);
    /* Settled target, not live t: a click 400ms into the flip used to write
       an oblique frame that is neither a tree portrait nor a scannable code. */
    var e = Render.easeInOutCubic(state.target);
    var cam = Render.makeCamera(state.scene.n, state.scene.maxZ, e, W, H);
    var amp = Render.WIND_AMP * (1 - e) * (1 - e);
    Render.drawGround(octx, state.scene, cam, W, H);
    Render.drawVoxels(octx, state.scene, cam, performance.now() - startTime, amp);
    var a = document.createElement('a');
    var name = 'qr-arboretum-' + state.species + '.png';
    a.download = name;
    a.href = off.toDataURL('image/png');
    a.click();
    confirmSave(name);
  }

  /* The export was silent: no toast, no filename, nothing. Peak-end says the
     last thing the visitor experiences is the download, so it should say what
     it produced. Routed through #scan, which is the live region, so it is
     announced rather than only shown. */
  var saveTimer = null;
  function confirmSave(name) {
    var scan = document.getElementById('scan');
    if (!scan) return;
    clearTimeout(saveTimer);
    scan.className = 'scan saved';
    scan.textContent = 'Saved ' + name;
    saveTimer = setTimeout(updateReadout, 4000);
  }

  function bind() {
    canvas = document.getElementById('stage');
    ctx = canvas.getContext('2d');

    var input = document.getElementById('url');
    input.value = state.text;
    var deb;
    input.addEventListener('input', function () {
      clearTimeout(deb);
      deb = setTimeout(function () { state.text = input.value.trim(); rebuild(); }, 220);
    });

    Scene.SPECIES.forEach(function (sp) {
      var b = document.createElement('button');
      b.className = 'tab' + (sp.id === state.species ? ' on' : '');
      b.dataset.id = sp.id;
      b.innerHTML = '<span class="season">' + sp.season + '</span><span class="sp">' + sp.name + '</span>';
      b.setAttribute('aria-pressed', sp.id === state.species ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.species = sp.id;
        document.querySelectorAll('.tab').forEach(function (o) {
          var on = o.dataset.id === sp.id;
          o.classList.toggle('on', on);
          o.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        rebuild();
      });
      document.getElementById('tabs').appendChild(b);
    });

    Palette.SWATCHES.forEach(function (s) {
      var b = document.createElement('button');
      b.className = 'swatch' + (s.id === state.swatch ? ' on' : '');
      b.dataset.id = s.id;
      b.style.background = s.hex;
      b.title = s.name + ' — ' + Palette.contrast(s.hex, Palette.PAVING).toFixed(1) + ':1 vs paving';
      b.setAttribute('aria-label', s.name);
      b.setAttribute('aria-pressed', s.id === state.swatch ? 'true' : 'false');
      b.addEventListener('click', function () {
        /* Clicking the active swatch returns to the species' own foliage - the
           load state, previously unreachable after a single click. */
        state.swatch = (state.swatch === s.id) ? null : s.id;
        document.querySelectorAll('.swatch').forEach(function (o) {
          var on = o.dataset.id === state.swatch;
          o.classList.toggle('on', on);
          o.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        rebuild();
      });
      document.getElementById('swatches').appendChild(b);
    });

    /* The label is static in the template, so before this it read "Flip to
       code" while already in the code view - naming the state, not the action.
       Keep it on the action the click performs. */
    function syncFlipLabel() {
      var b = document.getElementById('flip');
      if (b) b.textContent = state.target > 0.5 ? 'Flip to tree' : 'Flip to code';
    }
    function toggle() {
      state.target = state.target > 0.5 ? 0 : 1;
      syncFlipLabel();
    }
    syncFlipLabel();
    canvas.addEventListener('click', toggle);
    Render.attachStageKeys(canvas, toggle);
    document.getElementById('flip').addEventListener('click', toggle);
    document.getElementById('png').addEventListener('click', exportPNG);

    window.addEventListener('resize', resize);
  }

  // --- test hooks -------------------------------------------------------
  // The harness drives the render deterministically through these.
  window.__arb = {
    setState: function (o) {
      if (o.text !== undefined) state.text = o.text;
      if (o.species) state.species = o.species;
      if (o.swatch) state.swatch = o.swatch;
      rebuild();
      if (o.t !== undefined) { state.t = o.t; state.target = o.t; }
      // Same shape as the WebGL build's hook, so one harness drives both.
      return { version: state.qr.version, size: state.qr.size,
               voxels: state.scene.voxels.length, stats: state.scene.stats };
    },
    // Draw one frame at an explicit clock, bypassing rAF.
    renderAt: function (t, clock) {
      state.t = t; state.target = t;
      var e = Render.easeInOutCubic(t);
      var cam = Render.makeCamera(state.scene.n, state.scene.maxZ, e, W, H);
      var amp = Render.WIND_AMP * (1 - e) * (1 - e);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(ensureGround(state.scene, cam), 0, 0, W, H);
      Render.drawVoxels(ctx, state.scene, cam, clock, amp);
      return true;
    },
    faces: function (t, clock) {
      var e = Render.easeInOutCubic(t);
      var cam = Render.makeCamera(state.scene.n, state.scene.maxZ, e, W, H);
      var amp = Render.WIND_AMP * (1 - e) * (1 - e);
      return Render.collectFaces(state.scene, cam, clock, amp);
    },
    /* Geometry sweep, summarised in-page so the harness can cover every
       link x season x swatch combination without shipping megabytes of
       polygons over the CDP bridge. */
    geomCheck: function (t, clock) {
      var e = Render.easeInOutCubic(t);
      var cam = Render.makeCamera(state.scene.n, state.scene.maxZ, e, W, H);
      var amp = Render.WIND_AMP * (1 - e) * (1 - e);
      var faces = Render.collectFaces(state.scene, cam, clock, amp);
      var r = { voxels: state.scene.voxels.length, faces: faces.length,
                nonFinite: 0, zeroArea: 0, badVertexCount: 0, minArea: Infinity,
                zeroExtent: 0, outOfModule: 0, offDark: 0 };
      for (var i = 0; i < faces.length; i++) {
        var p = faces[i].pts;
        // shapes emit triangles, quads and ten-gons now, not only quads
        if (p.length < 6 || p.length % 2) { r.badVertexCount++; continue; }
        for (var k = 0; k < p.length; k++) if (!isFinite(p[k])) { r.nonFinite++; break; }
        if (!faces[i].col) r.badVertexCount++;
        var a = Math.abs(Render.shoelace(p));
        if (a < r.minArea) r.minArea = a;
        if (a <= Render.EPS_AREA) r.zeroArea++;
      }
      var vox = state.scene.voxels, m = state.qr.modules;
      for (var j = 0; j < vox.length; j++) {
        var v = vox[j];
        if (!(v.w > 0) || !(v.d > 0) || !(v.h > 0)) r.zeroExtent++;
        /* Ground tiles span whole modules of one colour, so they are checked
           for grid alignment instead of module containment - a merged region
           legitimately covers several modules. */
        if (v.shape === 'tile' || v.shape === 'plate') {
          if (v.x !== Math.round(v.x) || v.y !== Math.round(v.y) ||
              v.w !== Math.round(v.w) || v.d !== Math.round(v.d)) r.outOfModule++;
        } else if (Math.floor(v.x) !== Math.floor(v.x + v.w - 1e-9) ||
            Math.floor(v.y) !== Math.floor(v.y + v.d - 1e-9)) r.outOfModule++;
        var my2 = Math.floor(v.y), mx2 = Math.floor(v.x);
        if (!m[my2] || !m[my2][mx2]) r.offDark++;
      }
      if (r.minArea === Infinity) r.minArea = -1;
      return r;
    },
    matrix: function () { return state.qr.modules.map(function (r) { return r.map(function (v) { return v ? 1 : 0; }); }); },
    geom: function () {
      var e = Render.easeInOutCubic(1);
      var cam = Render.makeCamera(state.scene.n, state.scene.maxZ, e, W, H);
      return { scale: cam.scale, ox: cam.ox, oy: cam.oy, n: state.scene.n, W: W, H: H, dpr: dpr };
    },
    stats: function () { return state.scene.stats; },
    audit: function () { return Palette.audit(); },
    size: function () { return { W: W, H: H, dpr: dpr }; }
  };

  function init() {
    bind();
    resize();
    rebuild();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
