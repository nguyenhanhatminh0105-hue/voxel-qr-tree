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
    swatch: 'rose',
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
    try {
      state.qr = QR.encode(state.text || DEFAULT_URL, { ecl: 'M' });
      state.error = null;
    } catch (e) {
      state.error = e.message;
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
    var rnd = Scene.mulberry32(Scene.hashString(state.scene.id + '#p'));
    var count = Math.round(70);
    for (var i = 0; i < count; i++) {
      particles.push({
        x: rnd() * n, y: rnd() * n,
        z: rnd() * maxZ,
        fall: 0.6 + rnd() * 1.1,
        drift: rnd() * Math.PI * 2,
        size: 0.16 + rnd() * 0.16,
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
    ctx2.save();
    ctx2.globalAlpha = fade * 0.85;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      // fall and recycle; purely decorative, never touches the code
      var z = p.top - ((time * 0.001 * p.fall + p.drift) % 1) * (p.top + 1);
      var sway = Math.sin(time * 0.0016 + p.drift) * 0.5;
      var x = p.x + sway, y = p.y + sway * 0.4;
      if (x < 0 || y < 0 || x > n || y > n) continue;
      var sx = Render.projX(cam, x, y);
      var sy = Render.projY(cam, x, y, z);
      var s = p.size * cam.scale;
      ctx2.fillStyle = pal.foliageSide;
      ctx2.fillRect(sx - s / 2, sy - s / 2, s, s);
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
      drawParticles(ctx, scene, cam, time, Math.max(0, 1 - e / 0.6));
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
    var el = document.getElementById('readout');
    if (!el) return;
    if (state.error) { el.textContent = state.error; el.className = 'readout err'; return; }
    var q = state.qr;
    var pal = state.scene.palette;
    var ratio = Palette.contrast(pal.foliageTop, pal.paving).toFixed(1);
    var soil = Palette.contrast(pal.soil, pal.paving).toFixed(1);
    el.className = 'readout';
    el.textContent = 'version ' + q.version + '  ·  ' + q.size + '×' + q.size +
      '  ·  ecc ' + q.ecl + '  ·  mask ' + q.mask +
      '  ·  ' + state.scene.voxels.length + ' voxels' +
      '  ·  soil ' + soil + ':1, foliage ' + ratio + ':1 vs paving';
  }

  function exportPNG() {
    var scale = 2;
    var off = document.createElement('canvas');
    off.width = W * scale; off.height = H * scale;
    var octx = off.getContext('2d');
    octx.setTransform(scale, 0, 0, scale, 0, 0);
    var e = Render.easeInOutCubic(state.t);
    var cam = Render.makeCamera(state.scene.n, state.scene.maxZ, e, W, H);
    var amp = Render.WIND_AMP * (1 - e) * (1 - e);
    Render.drawGround(octx, state.scene, cam, W, H);
    Render.drawVoxels(octx, state.scene, cam, performance.now() - startTime, amp);
    var a = document.createElement('a');
    a.download = 'qr-arboretum-' + state.species + '.png';
    a.href = off.toDataURL('image/png');
    a.click();
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
      b.addEventListener('click', function () {
        state.species = sp.id;
        document.querySelectorAll('.tab').forEach(function (o) { o.classList.toggle('on', o.dataset.id === sp.id); });
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
      b.addEventListener('click', function () {
        state.swatch = s.id;
        document.querySelectorAll('.swatch').forEach(function (o) { o.classList.toggle('on', o.dataset.id === s.id); });
        rebuild();
      });
      document.getElementById('swatches').appendChild(b);
    });

    function toggle() { state.target = state.target > 0.5 ? 0 : 1; }
    canvas.addEventListener('click', toggle);
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
      return { version: state.qr.version, size: state.qr.size, voxels: state.scene.voxels.length };
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
        if (p.length !== 8) { r.badVertexCount++; continue; }
        for (var k = 0; k < 8; k++) if (!isFinite(p[k])) { r.nonFinite++; break; }
        if (!faces[i].col) r.badVertexCount++;
        var a = Math.abs(Render.shoelace(p));
        if (a < r.minArea) r.minArea = a;
        if (a <= Render.EPS_AREA) r.zeroArea++;
      }
      var vox = state.scene.voxels, m = state.qr.modules;
      for (var j = 0; j < vox.length; j++) {
        var v = vox[j];
        if (!(v.w > 0) || !(v.d > 0) || !(v.h > 0)) r.zeroExtent++;
        if (Math.floor(v.x) !== Math.floor(v.x + v.w - 1e-9) ||
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
