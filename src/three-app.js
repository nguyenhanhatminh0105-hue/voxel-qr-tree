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

  // swatch null = use the species' own foliage colour
  var state = { text: DEFAULT_URL, species: 'sakura', swatch: null, t: 0, target: 0 };
  var renderer, scene3, camera, petals, birds, snowCaps;
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
  /* SHAPES, not cubes. Nothing in the reference is a box, and no amount of
     tone work fixes a cube - the silhouette is what reads as blocky. Each
     shape is authored in local [0,1]^3 so the existing instance matrix (which
     maps a unit cube onto a voxel, shear included) drives it unchanged.

     Shading is baked into vertex colours as a LINEAR MULTIPLIER, and there
     are still no lights. Faces pointing straight up get factor 1.0, so a top
     face keeps exactly the tone the palette audited - which is the only
     surface the code depends on. Sides and undersides darken, which is what
     gives a sphere form without a light source that would push top faces
     brighter and through the contrast floor. */
  function withShading(g, banded) {
    if (g.index) g = g.toNonIndexed();   // Icosahedron is already non-indexed
    g.computeVertexNormals();
    var pos = g.attributes.position, nrm = g.attributes.normal;
    var col = new Float32Array(pos.count * 3);
    for (var i = 0; i < pos.count; i++) {
      var nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
      var f = 0.60 + 0.40 * Math.max(0, nz);          // top-lit
      f *= 1 - 0.10 * Math.max(0, -ny) - 0.05 * Math.max(0, nx);
      // horizontal bark banding, straight from the reference's trunk
      if (banded) f *= 0.93 + 0.07 * Math.cos(pos.getZ(i) * Math.PI * 7);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = f;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  }

  function shapeGeometry(shape) {
    var g;
    if (shape === 'blob') {
      // 20 faces: a soft rounded blossom, and barely dearer than a box
      g = new THREE.IcosahedronGeometry(0.5, 0);
      g.translate(0.5, 0.5, 0.5);
      return withShading(g);
    }
    if (shape === 'cyl') {
      g = new THREE.CylinderGeometry(0.44, 0.5, 1, 12, 4);
      g.rotateX(Math.PI / 2);                          // axis Y -> Z
      g.translate(0.5, 0.5, 0.5);
      return withShading(g, true);
    }
    if (shape === 'blade') {
      g = new THREE.CylinderGeometry(0.03, 0.5, 1, 4, 2);   // tapered spike
      g.rotateX(Math.PI / 2);
      g.translate(0.5, 0.5, 0.5);
      return withShading(g);
    }
    if (shape === 'tile') {
      // just the top surface: ground is flat, so nothing else is ever seen
      g = new THREE.PlaneGeometry(1, 1);
      g.translate(0.5, 0.5, 1);
      return withShading(g);
    }
    g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0.5, 0.5, 0.5);
    return withShading(g);
  }

  // --- scene build ------------------------------------------------------
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

    // one InstancedMesh per shape, each with its own per-instance colour
    var groups = {};
    for (var bi = 0; bi < boxes.length; bi++) {
      var sh = boxes[bi].shape || 'box';
      (groups[sh] || (groups[sh] = [])).push(bi);
    }
    var c = new THREE.Color();
    Object.keys(groups).sort().forEach(function (shape) {
      var idx = groups[shape];
      var mesh = new THREE.InstancedMesh(
        shapeGeometry(shape),
        new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, vertexColors: true }),
        idx.length
      );
      mesh.frustumCulled = false;
      for (var i = 0; i < idx.length; i++) {
        c.set(boxes[idx[i]].top);
        mesh.setColorAt(i, c);
      }
      mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.idx = idx;
      meshes.push(mesh);
      scene3.add(mesh);
    });

    applyWind(0, 0);
    buildPetals();
    updateReadout();
  }

  function buildPetals() {
    if (petals) {
      scene3.remove(petals); petals.geometry.dispose();
      if (petals.material.map) petals.material.map.dispose();
      petals.material.dispose(); petals = null;
    }
    if (birds) { scene3.remove(birds); birds.geometry.dispose(); birds.material.dispose(); birds = null; }
    if (snowCaps) {
      scene3.remove(snowCaps); snowCaps.geometry.dispose();
      if (snowCaps.material.map) snowCaps.material.map.dispose();
      snowCaps.material.dispose(); snowCaps = null;
    }
    if (reduceMotion) return;
    var n = state.scene.n, maxZ = state.scene.maxZ;
    var wx = Render.weatherFor(state.species);
    var rnd = Scene.mulberry32(Scene.hashString(state.scene.id + '#p'));
    var count = wx.count;
    var pos = new Float32Array(count * 3);
    var meta = [];
    for (var i = 0; i < count; i++) {
      // debris stays over the plot - the weather belongs to the arboretum
      meta.push({ x: rnd() * n, y: rnd() * n, fall: wx.fall + rnd() * wx.spread,
                  drift: rnd() * 6.283, top: maxZ });
      pos[i * 3] = meta[i].x;
      pos[i * 3 + 1] = -meta[i].y;               // three-space Y
      pos[i * 3 + 2] = rnd() * maxZ;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    /* The sprite is the same shape the canvas build draws, painted once into
       an offscreen canvas - one definition, so the two builds cannot drift. */
    petals = new THREE.Points(g, new THREE.PointsMaterial({
      map: fallSprite(wx.kind, wx.snow ? Render.SNOW_TINT : state.scene.palette.mat.leaf.sideA),
      /* The camera is orthographic, where sizeAttenuation derives point size
         from perspective distance and collapses these to nothing. Size is set
         in pixels each frame from the camera scale instead, so a flake stays
         a fixed number of modules wide however the plot is framed. */
      size: 8, sizeAttenuation: false, transparent: true,
      alphaTest: 0.12, depthWrite: false
    }));
    petals.userData.weather = wx;
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
    for (var mi = 0; mi < meshes.length; mi++) {
      var mesh = meshes[mi], idx = mesh.userData.idx, arr = mesh.instanceMatrix.array;
      for (var k = 0; k < idx.length; k++) {
        var v = boxes[idx[k]];
        var lo = 0, hi = 0;
        if (amp !== 0) {
          var sn = Math.sin(time * WIND_FREQ + v.phase);
          lo = amp * (v.swayLo || 0) * sn;
          hi = amp * (v.swayHi || 0) * sn;
        }
        /* The shear column displaces the top relative to the base. A grass
           blade's static splay is exactly that, so it simply adds here rather
           than needing a primitive of its own - and the blade then bends from
           its root under wind instead of leaning as a rigid stick. */
        var kx = (hi - lo) * WIND_DIR[0] + (v.leanX || 0);
        var ky = (hi - lo) * WIND_DIR[1] + (v.leanY || 0);
        _m.set(
          v.w, 0, kx, v.x + lo * WIND_DIR[0],
          0, -v.d, -ky, -(v.y + lo * WIND_DIR[1]),   // three-space Y = -world y
          0, 0, v.h, v.z,
          0, 0, 0, 1
        );
        _m.toArray(arr, k * 16);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
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

    // No face-visibility toggling: these are real solids, so the depth buffer
    // decides what is seen and a plan view simply shows their top surfaces.
    return { scale: W / (2 * halfW), halfW: halfW, halfH: halfH, n: n };
  }

  // --- loop -------------------------------------------------------------
  function drawFrame(t, clock) {
    var e = easeInOutCubic(t);
    var geom = setCamera(e);
    var amp = reduceMotion ? 0 : WIND_AMP * (1 - e) * (1 - e);
    applyWind(clock, amp);
    if (petals) {
      var pw = petals.userData.weather || { size: 1 };
      petals.material.size = Math.max(3, pw.size * geom.scale);
      var fade = Math.max(0, 1 - e / 0.6);
      petals.visible = fade > 0;
      petals.material.opacity = fade * 0.9;
      var p = petals.geometry.attributes.position, meta = petals.userData.meta;
      for (var i = 0; i < meta.length; i++) {
        var m = meta[i];
        p.array[i * 3 + 2] = m.top - ((clock * 0.001 * m.fall + m.drift) % 1) * (m.top + 1);
        var swayAmp = (petals.userData.weather || { sway: 0.9 }).sway;
        p.array[i * 3] = m.x + Math.sin(clock * 0.0016 + m.drift) * swayAmp;
      }
      p.needsUpdate = true;
    }
    var ambient = Math.max(0, 1 - e / 0.6);
    ensureSnowCaps();
    if (snowCaps) {
      snowCaps.visible = ambient > 0;
      snowCaps.material.opacity = ambient * 0.8;
      snowCaps.material.size = Math.max(4, 0.68 * geom.scale);
    }
    updateBirds(clock, ambient);
    renderer.render(scene3, camera);
    return geom;
  }

  /* Birds as open V line segments - two strokes per bird, so they read as
     birds rather than dots at this scale. They share the weather's fade, so
     the sky is empty long before the matrix has to read. */
  /* Snow on a winter canopy. Decorative and faded with the weather: the leaf's
     top face is the audited surface the code is read from, so it can never be
     repainted white without lifting dark modules toward light. */
  function ensureSnowCaps() {
    if (snowCaps || !state.scene || reduceMotion) return;
    if (!Render.weatherFor(state.species).snow || !state.scene.crownTops) return;
    var caps = state.scene.crownTops;
    var pos = new Float32Array(Math.ceil(caps.length / 2) * 3), w = 0;
    for (var i = 0; i < caps.length; i += 2) {
      pos[w * 3] = caps[i].x + 0.5;
      pos[w * 3 + 1] = -(caps[i].y + 0.5);
      pos[w * 3 + 2] = caps[i].z + 0.18;
      w++;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, w * 3), 3));
    snowCaps = new THREE.Points(g, new THREE.PointsMaterial({
      map: fallSprite('cap', Render.SNOW_TINT),
      size: 10, sizeAttenuation: false, transparent: true,
      alphaTest: 0.10, depthWrite: false
    }));
    snowCaps.frustumCulled = false;
    scene3.add(snowCaps);
  }

  function fallSprite(kind, colour) {
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var g2 = c.getContext('2d');
    g2.fillStyle = colour;
    g2.strokeStyle = colour;
    Render.paintFallShape(g2, kind, 32, 32, 58, 0);
    var tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
  }

  function ensureBirds() {
    if (birds || !state.scene || reduceMotion) return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(Render.BIRD_COUNT * 4 * 3), 3));
    birds = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: new THREE.Color(state.scene.palette.soil), transparent: true
    }));
    birds.frustumCulled = false;
    scene3.add(birds);
  }

  function updateBirds(clock, fade) {
    if (reduceMotion) return;
    ensureBirds();
    if (!birds) return;
    birds.visible = fade > 0;
    birds.material.opacity = fade * 0.6;
    if (fade <= 0) return;
    var list = Render.birdsAt(state.scene.n, state.scene.maxZ, clock);
    var a = birds.geometry.attributes.position.array;
    var span = state.scene.n * 0.035;
    for (var i = 0; i < list.length; i++) {
      var b = list[i], o = i * 12, lift = b.flap * 0.42 * span;
      // left stroke: wingtip -> body
      a[o] = b.x - span;      a[o + 1] = -b.y; a[o + 2] = b.z + lift;
      a[o + 3] = b.x;         a[o + 4] = -b.y; a[o + 5] = b.z;
      // right stroke: body -> wingtip
      a[o + 6] = b.x;         a[o + 7] = -b.y; a[o + 8] = b.z;
      a[o + 9] = b.x + span;  a[o + 10] = -b.y; a[o + 11] = b.z + lift;
    }
    birds.geometry.attributes.position.needsUpdate = true;
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

  /* The export was silent. Routed through #scan so it is announced, not just
     shown - the download is the last thing the visitor experiences. */
  var saveTimer = null;
  function confirmSave(name) {
    var scan = document.getElementById('scan');
    if (!scan) return;
    clearTimeout(saveTimer);
    scan.className = 'scan saved';
    scan.textContent = 'Saved ' + name;
    saveTimer = setTimeout(updateReadout, 4000);
  }

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
    renderer.domElement.addEventListener('click', toggle);
    Render.attachStageKeys(renderer.domElement, toggle);
    document.getElementById('flip').addEventListener('click', toggle);
    document.getElementById('png').addEventListener('click', function () {
      if (state.empty || state.error) return;
      /* Settled target, not live t: a click mid-flip used to write an oblique
         frame that is neither a tree portrait nor a scannable code. */
      drawFrame(state.target, performance.now() - startTime);
      var a = document.createElement('a');
      var name = 'qr-arboretum-3d-' + state.species + '.png';
      a.download = name;
      a.href = renderer.domElement.toDataURL('image/png');
      a.click();
      confirmSave(name);
    });
    window.addEventListener('resize', resize);
  }

  function init() {
    var wrap = document.getElementById('stagewrap');
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true          // for PNG export and for the harness
    });
    /* The quiet zone is the clear colour, so it has to survive a lost context.
       three.js rebuilds its background module inside initGLContext(), which it
       re-runs on 'webglcontextrestored' - and that fresh module starts at black.
       Nothing re-applies ours, so after any context loss the 4-module margin
       comes back BLACK: the one region a scanner needs light. Headless
       SwiftShader loses the context during startup every time, so this was the
       shipped behaviour, not an edge case. three.js registers its own restore
       handler in the constructor above, so ours runs after initGLContext(). */
    function applyClearColour() {
      renderer.setClearColor(new THREE.Color(Palette.PAVING), 1);
    }
    applyClearColour();
    renderer.domElement.addEventListener('webglcontextrestored', applyClearColour);
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
      r.faces = 0;
      meshes.forEach(function (m) {
        r.faces += m.count * (m.geometry.attributes.position.count / 3);
      });
      var vox = state.scene.voxels, m2 = state.qr.modules;
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
