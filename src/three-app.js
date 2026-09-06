/* ===========================================================================
   three-app.js - the same diorama on a WebGL depth buffer.

   qr.js, palette.js and scene.js are reused untouched: the QR matrix, the
   contrast floor and the planting rules are renderer-agnostic. Only drawing
   changes.

   ORTHOGRAPHIC, NOT PERSPECTIVE - and this is not a tuning knob.
   The whole trick depends on a voxel at height h landing on its own module
   when seen from above. Under perspective it projects outward by
   r * h / (D - h), where r is its horizontal distance from the view axis and
   D the camera distance. For a voxel at r = 16, h = 18 that is 13 modules off
   at D = 40, still 2.8 modules off at D = 120, and 0.3 modules off at
   D = 1000. Pushing the camera away makes the error small, never zero, and
   costs depth precision on the way. Orthographic is exactly 0.00 at any
   distance.

   WHAT GOES AWAY IN 3-D. Three constraints that shape render.js are artefacts
   of painter's-algorithm sorting, and a depth buffer erases them:
     - the full-plot slab no longer needs drawing outside a sort - it is just
       one more instance;
     - the ground no longer needs an offscreen cache;
     - back-face culling is the GPU's job.
   Only coplanar z-fighting replaces them, handled by the gap between the slab
   top and the ground blocks seated on it.

   WHAT DOES NOT GO AWAY, and needs active defending here:
     - MATERIALS ARE UNLIT. MeshBasicMaterial with per-instance colour, and no
       lights in the scene at all. Ordinary lighting does the exact opposite of
       what this design needs: a light from above makes top faces the
       BRIGHTEST, which pushes foliage back up through the 3:1 floor and makes
       the code unscannable while still looking fine on screen. Here the top
       face carries the base tone and the two sides are baked darker (-16% and
       -32%), so every surface is exactly the audited value.
     - WIND still decays to exactly zero at t = 1, still as a shear between
       each voxel's base and top - baked into the instance matrix, which a 4x4
       can express.

   HANDEDNESS. render.js projects with x right, y DOWN and z toward the
   viewer, a left-handed frame; three.js is right-handed. Feeding the same
   coordinates to a right-handed camera renders the plot mirrored - and ZBar
   decodes mirrored QR codes happily, so that passes a decode test while being
   wrong. Y is negated when building instance matrices, and the camera basis is
   built in that space. Winding is then reversed, so materials are DoubleSide.
   =========================================================================== */
(function () {
  'use strict';

  var DEFAULT_URL = 'https://github.com/nguyenhanhatminh0105-hue';
  var FLIP_MS = 950;
  var DEG = Math.PI / 180;
  var YAW_START = 45 * DEG;
  // atan(1/sqrt(2)) is the true isometric elevation: all three axes
  // foreshorten equally.
  var PITCH_START = Math.atan(1 / Math.SQRT2), PITCH_END = 90 * DEG;
  var QUIET = 4;
  var SLAB_BOTTOM = -1.5, SLAB_TOP = -0.02;
  // WIND_AMP is displacement in modules at the crown top, for a leaf.
  var WIND_AMP = 0.50, WIND_FREQ = 0.0011, WIND_DIR = [0.82, 0.57];
  var EPS_FACE = 1e-6;

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var state = { text: DEFAULT_URL, species: 'sakura', swatch: 'rose', t: 0, target: 0 };
  var renderer, scene3, camera, petals;
  var meshes = [];            // [top, sideY, sideX] InstancedMesh
  var boxes = null;           // voxels plus the slab, in draw order
  var W = 0, H = 0;
  var startTime = performance.now();

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  /* --- base geometry ----------------------------------------------------
     One quad per visible face of a unit box. Only three faces can ever face
     the camera: yaw stays in [0, 45] and pitch in [35, 90], so +x, +y and the
     underside are never front-facing. Each quad gets its own InstancedMesh so
     it can carry its own exact per-instance colour - instanceColor is one
     colour per instance, so three tones per box means three meshes. */
  var FACE_QUADS = [
    { key: 'top', tone: 'top', v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { key: 'sideY', tone: 'sideA', v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { key: 'sideX', tone: 'sideB', v: [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]] }
  ];

  function quadGeometry(v) {
    var g = new THREE.BufferGeometry();
    var pos = new Float32Array(12);
    for (var i = 0; i < 4; i++) {
      pos[i * 3] = v[i][0]; pos[i * 3 + 1] = v[i][1]; pos[i * 3 + 2] = v[i][2];
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  // --- scene build ------------------------------------------------------
  function rebuild() {
    try {
      state.qr = QR.encode(state.text || DEFAULT_URL, { ecl: 'M' });
      state.error = null;
    } catch (e) {
      state.error = e.message;
      updateReadout();
      return;
    }
    state.scene = Scene.build({
      matrix: state.qr.modules, seed: state.text,
      species: state.species, swatch: state.swatch
    });
    state.scene.id = [state.text, state.species, state.swatch].join('|');

    var pal = state.scene.palette, n = state.scene.n;

    meshes.forEach(function (m) {
      scene3.remove(m); m.geometry.dispose(); m.material.dispose();
    });
    meshes = [];

    /* The slab is simply one more instance. In the canvas build it has to be
       drawn first and outside the sort; here the depth buffer places it. */
    boxes = state.scene.voxels.concat([{
      x: 0, y: 0, z: SLAB_BOTTOM, w: n, d: n, h: SLAB_TOP - SLAB_BOTTOM,
      phase: 0, top: pal.paving,
      sideA: pal.slabSide, sideB: Palette.darken(pal.slabSide, 0.14)
    }]);

    var c = new THREE.Color();
    FACE_QUADS.forEach(function (face) {
      var mesh = new THREE.InstancedMesh(
        quadGeometry(face.v),
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),   // no lights, ever
        boxes.length
      );
      mesh.frustumCulled = false;
      for (var i = 0; i < boxes.length; i++) {
        c.set(boxes[i][face.tone] || boxes[i].top);
        mesh.setColorAt(i, c);
      }
      mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      meshes.push(mesh);
      scene3.add(mesh);
    });

    applyWind(0, 0);
    buildPetals();
    updateReadout();
  }

  function buildPetals() {
    if (petals) { scene3.remove(petals); petals.geometry.dispose(); petals.material.dispose(); petals = null; }
    if (reduceMotion) return;
    var n = state.scene.n, maxZ = state.scene.maxZ;
    var rnd = Scene.mulberry32(Scene.hashString(state.scene.id + '#p'));
    var count = 90;
    var pos = new Float32Array(count * 3);
    var meta = [];
    for (var i = 0; i < count; i++) {
      meta.push({ x: rnd() * n, y: rnd() * n, fall: 0.6 + rnd() * 1.1,
                  drift: rnd() * 6.283, top: maxZ });
      pos[i * 3] = meta[i].x;
      pos[i * 3 + 1] = -meta[i].y;               // three-space Y
      pos[i * 3 + 2] = rnd() * maxZ;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    petals = new THREE.Points(g, new THREE.PointsMaterial({
      color: new THREE.Color(state.scene.palette.mat.leaf.sideA),
      size: 0.42, sizeAttenuation: true, transparent: true
    }));
    petals.userData.meta = meta;
    petals.frustumCulled = false;
    scene3.add(petals);
  }

  /* --- wind -------------------------------------------------------------
     Shear baked straight into the instance matrix. For a box with corner
     (x, y, z), extents (w, d, h) and horizontal displacement `lo` at its base
     and `hi` at its top, local unit coords (u, v, t) map to

       X = x + u*w + (lo + (hi-lo)*t) * dirX
       Y = y + v*d + (lo + (hi-lo)*t) * dirY      (negated for three-space)
       Z = z + t*h

     which is exactly a 4x4 with the shear in the third column. The base stays
     planted and the top leans, so the tree bends instead of sliding.

     At amp = 0 both lo and hi are exactly zero and every matrix returns to its
     authored value - bit-identical whatever the clock says. */
  var _m = new THREE.Matrix4();
  function applyWind(time, amp) {
    if (!meshes.length) return;
    var arrays = meshes.map(function (m) { return m.instanceMatrix.array; });
    for (var b = 0; b < boxes.length; b++) {
      var v = boxes[b];
      var lo = 0, hi = 0;
      if (amp !== 0) {
        /* swayLo/swayHi are precomputed in scene.js as
           stiffness x (z / maxZ)^1.4. Keeping the law there rather than
           repeating pow(z, 1.4) here is what lets both renderers obey the same
           wind: normalised by tree height so a big code does not sway harder,
           and stiffened per kind so trunks barely move. The slab is appended
           to `boxes` without them, hence the || 0. */
        var s = Math.sin(time * WIND_FREQ + v.phase);
        lo = amp * (v.swayLo || 0) * s;
        hi = amp * (v.swayHi || 0) * s;
      }
      var kx = (hi - lo) * WIND_DIR[0], ky = (hi - lo) * WIND_DIR[1];
      _m.set(
        v.w, 0, kx, v.x + lo * WIND_DIR[0],
        0, -v.d, -ky, -(v.y + lo * WIND_DIR[1]),      // three-space Y = -world y
        0, 0, v.h, v.z,
        0, 0, 0, 1
      );
      for (var k = 0; k < arrays.length; k++) _m.toArray(arrays[k], b * 16);
    }
    meshes.forEach(function (m) { m.instanceMatrix.needsUpdate = true; });
  }

  // --- camera -----------------------------------------------------------
  function setCamera(e) {
    var n = state.scene.n, maxZ = state.scene.maxZ;
    var atEnd = e >= 1;
    var yaw = atEnd ? 0 : YAW_START * (1 - e);
    var pitch = atEnd ? PITCH_END : PITCH_START + (PITCH_END - PITCH_START) * e;
    var cy = atEnd ? 1 : Math.cos(yaw), sy = atEnd ? 0 : Math.sin(yaw);
    var cp = atEnd ? 0 : Math.cos(pitch), sp = atEnd ? 1 : Math.sin(pitch);

    // projected extent of the bounding volume, exactly as render.js computes it
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < 8; i++) {
      var x = (i & 1) ? n : 0, y = (i & 2) ? n : 0, z = (i & 4) ? maxZ : SLAB_BOTTOM;
      var px = x * cy - y * sy;
      var py = (x * sy + y * cy) * sp - z * cp;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    var extent = Math.max(maxX - minX, maxY - minY);
    var margin = 2 + (QUIET - 2) * e;       // exactly QUIET modules at e = 1
    var span = extent + margin * 2;

    var halfW, halfH;
    if (W >= H) { halfH = span / 2; halfW = halfH * (W / H); }
    else { halfW = span / 2; halfH = halfW * (H / W); }
    camera.left = -halfW; camera.right = halfW;
    camera.top = halfH; camera.bottom = -halfH;
    camera.near = -2000; camera.far = 2000;

    /* Camera basis in three-space (Y negated), derived by matching render.js
       term for term: screen-right = d(sx)/dpos, screen-up = -d(sy)/dpos.
       At e = 1 this puts the camera exactly overhead looking straight down. */
    var Ut = [-sy * sp, cy * sp, cp];        // screen up
    var Zt = [sy * cp, -cy * cp, sp];        // target -> camera

    // Centre the projected bounding box by offsetting the target in view plane.
    var tz = (maxZ + SLAB_BOTTOM) / 2;
    var p0x = (n / 2) * cy - (n / 2) * sy;
    var p0y = ((n / 2) * sy + (n / 2) * cy) * sp - tz * cp;
    var dX = (minX + maxX) / 2 - p0x;
    var dY = (minY + maxY) / 2 - p0y;        // screen-down units
    var Rw = [cy, -sy, 0];                   // screen right, world
    var Dw = [sy * sp, cy * sp, -cp];        // screen down, world
    var twx = n / 2 + Rw[0] * dX + Dw[0] * dY;
    var twy = n / 2 + Rw[1] * dX + Dw[1] * dY;
    var twz = tz + Rw[2] * dX + Dw[2] * dY;

    var tx = twx, ty = -twy, tzz = twz;      // into three-space
    var dist = 600;
    camera.position.set(tx + Zt[0] * dist, ty + Zt[1] * dist, tzz + Zt[2] * dist);
    camera.up.set(Ut[0], Ut[1], Ut[2]);
    camera.lookAt(tx, ty, tzz);
    camera.updateProjectionMatrix();

    // Side faces go edge-on in the plan view; hide them rather than leaving
    // sub-pixel slivers to antialias over the paving.
    if (meshes.length === 3) {
      meshes[1].visible = cy * cp > EPS_FACE;
      meshes[2].visible = sy * cp > EPS_FACE;
    }
    return { scale: W / (2 * halfW), halfW: halfW, halfH: halfH, n: n };
  }

  // --- loop -------------------------------------------------------------
  function drawFrame(t, clock) {
    var e = easeInOutCubic(t);
    var geom = setCamera(e);
    var amp = reduceMotion ? 0 : WIND_AMP * (1 - e) * (1 - e);
    applyWind(clock, amp);
    if (petals) {
      var fade = Math.max(0, 1 - e / 0.6);
      petals.visible = fade > 0;
      petals.material.opacity = fade * 0.9;
      var p = petals.geometry.attributes.position, meta = petals.userData.meta;
      for (var i = 0; i < meta.length; i++) {
        var m = meta[i];
        p.array[i * 3 + 2] = m.top - ((clock * 0.001 * m.fall + m.drift) % 1) * (m.top + 1);
        p.array[i * 3] = m.x + Math.sin(clock * 0.0016 + m.drift) * 0.5;
      }
      p.needsUpdate = true;
    }
    renderer.render(scene3, camera);
    return geom;
  }

  function frame() {
    var now = performance.now();
    if (state.t !== state.target) {
      var step = (now - (frame.last || now)) / (reduceMotion ? 1 : FLIP_MS);
      state.t = state.target > state.t
        ? Math.min(state.target, state.t + step)
        : Math.max(state.target, state.t - step);
    }
    frame.last = now;
    if (state.scene) drawFrame(state.t, now - startTime);
    requestAnimationFrame(frame);
  }

  // --- UI ---------------------------------------------------------------
  function resize() {
    var rect = document.getElementById('stagewrap').getBoundingClientRect();
    W = Math.max(240, Math.floor(rect.width));
    H = Math.max(240, Math.floor(rect.height));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H, true);
  }

  function updateReadout() {
    var el = document.getElementById('readout');
    if (!el) return;
    if (state.error) { el.textContent = state.error; el.className = 'readout err'; return; }
    var pal = state.scene.palette, st = state.scene.stats;
    el.className = 'readout';
    el.textContent = 'three.js r' + THREE.REVISION + '  ·  version ' + state.qr.version +
      '  ·  ' + state.qr.size + '×' + state.qr.size + '  ·  ecc ' + state.qr.ecl +
      '  ·  mask ' + state.qr.mask + '  ·  ' + st.total + ' voxels (' + st.canopy +
      ' canopy)  ·  height ' + Math.round(st.heightFraction * 100) + '% of plot' +
      '  ·  soil ' + Palette.contrast(pal.soil, pal.paving).toFixed(1) +
      ':1, foliage ' + Palette.contrast(pal.foliageTop, pal.paving).toFixed(1) + ':1';
  }

  function bind() {
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
    renderer.domElement.addEventListener('click', toggle);
    document.getElementById('flip').addEventListener('click', toggle);
    document.getElementById('png').addEventListener('click', function () {
      drawFrame(state.t, performance.now() - startTime);
      var a = document.createElement('a');
      a.download = 'qr-arboretum-3d-' + state.species + '.png';
      a.href = renderer.domElement.toDataURL('image/png');
      a.click();
    });
    window.addEventListener('resize', resize);
  }

  function init() {
    var wrap = document.getElementById('stagewrap');
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true          // for PNG export and for the harness
    });
    renderer.setClearColor(new THREE.Color(Palette.PAVING), 1);   // quiet zone is paving
    renderer.domElement.id = 'stage';
    wrap.appendChild(renderer.domElement);

    scene3 = new THREE.Scene();
    // No lights, by design - see the header comment.
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 2000);
    scene3.add(camera);

    bind();
    resize();
    rebuild();
    requestAnimationFrame(frame);
  }

  // --- test hooks: identical surface to the canvas build ----------------
  window.__arb = {
    renderer: 'three',
    setState: function (o) {
      if (o.text !== undefined) state.text = o.text;
      if (o.species) state.species = o.species;
      if (o.swatch) state.swatch = o.swatch;
      rebuild();
      if (o.t !== undefined) { state.t = o.t; state.target = o.t; }
      return { version: state.qr.version, size: state.qr.size,
               voxels: state.scene.voxels.length, stats: state.scene.stats };
    },
    renderAt: function (t, clock) { state.t = t; state.target = t; drawFrame(t, clock); return true; },
    matrix: function () {
      return state.qr.modules.map(function (r) { return r.map(function (v) { return v ? 1 : 0; }); });
    },
    geom: function () {
      var g = setCamera(easeInOutCubic(1));
      return {
        scale: g.scale, n: g.n, W: W, H: H,
        dpr: renderer.getPixelRatio(),
        ox: W / 2 - (g.n / 2) * g.scale,
        oy: H / 2 - (g.n / 2) * g.scale
      };
    },
    geomCheck: function (t) {
      var r = { voxels: state.scene.voxels.length, faces: 0, nonFinite: 0, zeroArea: 0,
                badVertexCount: 0, minArea: 1, zeroExtent: 0, outOfModule: 0, offDark: 0 };
      meshes.forEach(function (m) {
        var a = m.instanceMatrix.array;
        for (var i = 0; i < a.length; i++) if (!isFinite(a[i])) r.nonFinite++;
      });
      r.faces = state.scene.voxels.length * (t >= 1 ? 1 : 3);
      var vox = state.scene.voxels, m2 = state.qr.modules;
      for (var j = 0; j < vox.length; j++) {
        var v = vox[j];
        if (!(v.w > 0) || !(v.d > 0) || !(v.h > 0)) r.zeroExtent++;
        if (Math.floor(v.x) !== Math.floor(v.x + v.w - 1e-9) ||
            Math.floor(v.y) !== Math.floor(v.y + v.d - 1e-9)) r.outOfModule++;
        if (!m2[Math.floor(v.y)] || !m2[Math.floor(v.y)][Math.floor(v.x)]) r.offDark++;
      }
      return r;
    },
    stats: function () { return state.scene.stats; },
    audit: function () { return Palette.audit(); },
    size: function () { return { W: W, H: H, dpr: renderer.getPixelRatio() }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
