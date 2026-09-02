/* ===========================================================================
   three-app.js - the same diorama on a WebGL depth buffer.

   qr.js, palette.js and scene.js are reused untouched: the QR matrix, the
   contrast floor and the planting rules are renderer-agnostic. Only drawing
   changes.

   WHAT GOES AWAY IN 3-D. Three of the constraints that shape render.js are
   artefacts of painter's-algorithm sorting, and a depth buffer simply erases
   them:
     - the full-plot slab no longer needs to be drawn outside a sort, because
       there is no sort;
     - ground tiles no longer need an offscreen cache, because nothing is
       re-rasterised per frame that the GPU cannot redo for free;
     - back-face culling is the GPU's job.
   Only coplanar z-fighting replaces them, handled by lifting the tiles a
   hair above the slab.

   WHAT DOES NOT GO AWAY. Every constraint that comes from the code itself
   survives unchanged, and two need active defending here:
     - MATERIALS ARE UNLIT. MeshBasicMaterial with baked vertex colours, no
       lights in the scene. A directional light would scale the top-face
       colours by an angle-dependent factor and quietly walk them back through
       the contrast floor; baking the two-tone shading into vertex colours
       keeps every surface exactly the audited value.
     - WIND still decays to exactly zero at t = 1, and is still a shear
       applied between each voxel's base and top.
   =========================================================================== */
(function () {
  'use strict';

  var DEFAULT_URL = 'https://github.com/nguyenhanhatminh0105-hue';
  var FLIP_MS = 950;
  var DEG = Math.PI / 180;
  var YAW_START = 45 * DEG, PITCH_START = 35 * DEG, PITCH_END = 90 * DEG;
  var QUIET = 4, SLAB_H = 0.9;
  var WIND_AMP = 0.020, WIND_FREQ = 0.0011, WIND_DIR = [0.82, 0.57];

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var state = { text: DEFAULT_URL, species: 'sakura', swatch: 'rose', t: 0, target: 0 };
  var renderer, scene3, camera, treeMesh, groundMesh, petals;
  var W = 0, H = 0, basePos = null, voxRef = null;
  var startTime = performance.now();

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // --- geometry ---------------------------------------------------------
  // Only the three faces the camera can ever see, matching render.js: top,
  // -x and -y. Yaw stays in [0, 45] and pitch in [35, 90], so the others are
  // never front-facing.
  /* HANDEDNESS. render.js projects with x right, y DOWN and z toward the
     viewer, which is a left-handed frame; three.js is right-handed. Feeding
     the same coordinates to a right-handed camera renders the whole plot
     mirrored left-to-right - and ZBar happily decodes mirrored QR codes, so
     this passes a decode test while being wrong. The fix is to negate Y when
     writing vertices (three-space Y = -world y) and to build the camera basis
     in that space. Faces are then wound backwards, so materials are
     DoubleSide; with a depth buffer and opaque geometry that costs nothing. */
  var FACES = [
    { n: 'top', v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], tone: 'top' },
    { n: 'sy', v: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], tone: 'sideA' },
    { n: 'sx', v: [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]], tone: 'sideB' }
  ];

  function boxGeometry(boxes) {
    var count = boxes.length * FACES.length * 4;
    var pos = new Float32Array(count * 3);
    var col = new Float32Array(count * 3);
    var idx = new (count > 65535 ? Uint32Array : Uint16Array)(boxes.length * FACES.length * 6);
    var c = new THREE.Color();
    var vi = 0, ii = 0;

    for (var b = 0; b < boxes.length; b++) {
      var box = boxes[b];
      for (var f = 0; f < FACES.length; f++) {
        var face = FACES[f];
        c.set(box[face.tone] || box.top);
        var base = vi;
        for (var k = 0; k < 4; k++) {
          var u = face.v[k];
          pos[vi * 3] = box.x + u[0] * box.w;
          pos[vi * 3 + 1] = -(box.y + u[1] * box.d);      // three-space Y = -world y
          pos[vi * 3 + 2] = box.z + u[2] * box.h;
          col[vi * 3] = c.r; col[vi * 3 + 1] = c.g; col[vi * 3 + 2] = c.b;
          vi++;
        }
        idx[ii++] = base; idx[ii++] = base + 1; idx[ii++] = base + 2;
        idx[ii++] = base; idx[ii++] = base + 2; idx[ii++] = base + 3;
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }

  function unlitMesh(geom) {
    return new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
      vertexColors: true,           // unlit: colours stay exactly as audited
      side: THREE.DoubleSide        // Y is negated, so winding is reversed
    }));
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

    if (treeMesh) { scene3.remove(treeMesh); treeMesh.geometry.dispose(); treeMesh.material.dispose(); }
    if (groundMesh) { scene3.remove(groundMesh); groundMesh.geometry.dispose(); groundMesh.material.dispose(); }

    // ground: slab plus one flat plate per dark module. The depth buffer
    // orders these against everything standing on them, so there is no draw
    // order to get wrong here.
    var ground = [{
      x: 0, y: 0, z: -SLAB_H, w: n, d: n, h: SLAB_H - 0.01,
      top: pal.paving, sideA: pal.slabSide, sideB: Palette.darken(pal.slabSide, 0.14)
    }];
    for (var my = 0; my < n; my++) {
      for (var mx = 0; mx < n; mx++) {
        if (!state.qr.modules[my][mx]) continue;
        var j = ((mx * 73856093) ^ (my * 19349663)) >>> 0;
        var shade = ((j >>> 8) & 255) / 255 * 0.10;   // dark modules vary DARKER only
        var soil = Palette.darken(pal.soil, shade);
        ground.push({ x: mx, y: my, z: -0.01, w: 1, d: 1, h: 0.01,
                      top: soil, sideA: soil, sideB: soil });
      }
    }
    groundMesh = unlitMesh(boxGeometry(ground));
    scene3.add(groundMesh);

    treeMesh = unlitMesh(boxGeometry(state.scene.voxels));
    basePos = treeMesh.geometry.attributes.position.array.slice();
    voxRef = state.scene.voxels;
    scene3.add(treeMesh);

    buildPetals();
    updateReadout();
  }

  function buildPetals() {
    if (petals) { scene3.remove(petals); petals.geometry.dispose(); petals.material.dispose(); petals = null; }
    if (reduceMotion) return;
    var n = state.scene.n, maxZ = state.scene.maxZ;
    var rnd = Scene.mulberry32(Scene.hashString(state.scene.id + '#p'));
    var count = 80;
    var pos = new Float32Array(count * 3);
    var meta = [];
    for (var i = 0; i < count; i++) {
      meta.push({ x: rnd() * n, y: rnd() * n, fall: 0.6 + rnd() * 1.1, drift: rnd() * 6.283, top: maxZ });
      pos[i * 3] = meta[i].x; pos[i * 3 + 1] = -meta[i].y; pos[i * 3 + 2] = rnd() * maxZ;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    petals = new THREE.Points(g, new THREE.PointsMaterial({
      color: new THREE.Color(state.scene.palette.foliageTop),
      size: 0.3, sizeAttenuation: true, transparent: true
    }));
    petals.userData.meta = meta;
    scene3.add(petals);
  }

  // --- wind -------------------------------------------------------------
  /* Shear every voxel between its base and its top. Amplitude carries the
     (1 - t)^2 factor, so at t = 1 the offsets are exactly zero and every
     vertex returns to its authored position - bit-identical whatever the
     clock says. */
  function applyWind(time, amp) {
    var attr = treeMesh.geometry.attributes.position;
    var arr = attr.array;
    if (amp === 0) {
      arr.set(basePos);
      attr.needsUpdate = true;
      return;
    }
    var per = FACES.length * 4;
    for (var b = 0; b < voxRef.length; b++) {
      var v = voxRef[b];
      var s = Math.sin(time * WIND_FREQ + v.phase);
      var lo = amp * Math.pow(v.z > 0 ? v.z : 0, 1.4) * s;
      var hi = amp * Math.pow(v.z + v.h > 0 ? v.z + v.h : 0, 1.4) * s;
      for (var k = 0; k < per; k++) {
        var i3 = (b * per + k) * 3;
        // pick the base or top offset by which end of the box this vertex is on
        var atTop = basePos[i3 + 2] > v.z + v.h * 0.5;
        var d = atTop ? hi : lo;
        arr[i3] = basePos[i3] + d * WIND_DIR[0];
        arr[i3 + 1] = basePos[i3 + 1] - d * WIND_DIR[1];   // negated Y
      }
    }
    attr.needsUpdate = true;
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
      var x = (i & 1) ? n : 0, y = (i & 2) ? n : 0, z = (i & 4) ? maxZ : -SLAB_H;
      var vx = x * cy - y * sy, vy = x * sy + y * cy;
      var px = vx, py = vy * sp - z * cp;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    var extent = Math.max(maxX - minX, maxY - minY);
    var margin = 2 + (QUIET - 2) * e;
    var span = extent + margin * 2;

    var halfW, halfH;
    if (W >= H) { halfH = span / 2; halfW = halfH * (W / H); }
    else { halfW = span / 2; halfH = halfW * (H / W); }
    camera.left = -halfW; camera.right = halfW;
    camera.top = halfH; camera.bottom = -halfH;
    camera.near = -1000; camera.far = 1000;

    /* Camera basis in three-space (Y negated). Derived by matching render.js
       term for term:  screen-right = d(sx)/d(pos),  screen-up = -d(sy)/d(pos).
       At e = 1 this puts the camera exactly overhead looking straight down. */
    var Rt = [cy, sy, 0];                       // screen right
    var Ut = [-sy * sp, cy * sp, cp];           // screen up
    var Zt = [sy * cp, -cy * cp, sp];           // target -> camera

    // Centre the projected bounding box: offset the target within the view plane.
    var tz = (maxZ - SLAB_H) / 2;
    var p0x = (n / 2) * cy - (n / 2) * sy;
    var p0y = ((n / 2) * sy + (n / 2) * cy) * sp - tz * cp;
    var dX = (minX + maxX) / 2 - p0x;
    var dY = (minY + maxY) / 2 - p0y;           // screen-down units
    var Rw = [cy, -sy, 0];                      // screen right, world
    var Dw = [sy * sp, cy * sp, -cp];           // screen down, world
    var twx = n / 2 + Rw[0] * dX + Dw[0] * dY;
    var twy = n / 2 + Rw[1] * dX + Dw[1] * dY;
    var twz = tz + Rw[2] * dX + Dw[2] * dY;

    var tx = twx, ty = -twy, tzz = twz;         // into three-space
    var dist = 400;
    camera.position.set(tx + Zt[0] * dist, ty + Zt[1] * dist, tzz + Zt[2] * dist);
    camera.up.set(Ut[0], Ut[1], Ut[2]);
    camera.lookAt(tx, ty, tzz);
    camera.updateProjectionMatrix();
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
      petals.material.opacity = fade * 0.85;
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
    var pal = state.scene.palette;
    el.className = 'readout';
    el.textContent = 'three.js r' + THREE.REVISION + '  ·  version ' + state.qr.version +
      '  ·  ' + state.qr.size + '×' + state.qr.size + '  ·  ecc ' + state.qr.ecl +
      '  ·  mask ' + state.qr.mask + '  ·  ' + state.scene.voxels.length + ' voxels' +
      '  ·  soil ' + Palette.contrast(pal.soil, pal.paving).toFixed(1) +
      ':1, foliage ' + Palette.contrast(pal.foliageTop, pal.paving).toFixed(1) + ':1 vs paving';
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
      preserveDrawingBuffer: true          // needed for PNG export and for the harness
    });
    renderer.setClearColor(new THREE.Color(Palette.PAVING), 1);   // quiet zone is paving
    renderer.domElement.id = 'stage';
    wrap.appendChild(renderer.domElement);

    scene3 = new THREE.Scene();
    // No lights, by design - see the header comment.
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
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
      return { version: state.qr.version, size: state.qr.size, voxels: state.scene.voxels.length };
    },
    renderAt: function (t, clock) { state.t = t; state.target = t; drawFrame(t, clock); return true; },
    matrix: function () {
      return state.qr.modules.map(function (r) { return r.map(function (v) { return v ? 1 : 0; }); });
    },
    geom: function () {
      var g = setCamera(easeInOutCubic(1));
      // module (mx,my) centre -> css px: ox + (mx+0.5)*scale
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
      var pos = treeMesh.geometry.attributes.position.array;
      for (var i = 0; i < pos.length; i++) if (!isFinite(pos[i])) r.nonFinite++;
      r.faces = state.scene.voxels.length * (t >= 1 ? 1 : 3);
      var vox = state.scene.voxels, m = state.qr.modules;
      for (var j = 0; j < vox.length; j++) {
        var v = vox[j];
        if (!(v.w > 0) || !(v.d > 0) || !(v.h > 0)) r.zeroExtent++;
        if (Math.floor(v.x) !== Math.floor(v.x + v.w - 1e-9) ||
            Math.floor(v.y) !== Math.floor(v.y + v.d - 1e-9)) r.outOfModule++;
        if (!m[Math.floor(v.y)] || !m[Math.floor(v.y)][Math.floor(v.x)]) r.offDark++;
      }
      return r;
    },
    audit: function () { return Palette.audit(); },
    size: function () { return { W: W, H: H, dpr: renderer.getPixelRatio() }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
