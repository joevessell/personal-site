/*
 * Escalate: a rotatable 3D planet with a small ecosystem, played as an arcade challenge.
 * Plain Canvas 2D + hand-rolled 3D math, no dependencies.
 *
 * Species
 *   Cubebell    (blue, 35px):   a plant on every other grid square. Never moves.
 *   Butterblock (yellow, 25px): wanders; divides each time it touches a Cubebell.
 *   Rubytile    (red, 15px):    wanders; eating a Butterblock kills it and the Rubytile
 *                               divides. Starves if it goes too long without eating.
 *
 * Goal: keep all three species alive for 100.0s.
 *
 * Coordinate system
 *   World space: unit sphere, +Y is the north pole.
 *   View space:  +X right, +Y up, +Z toward the viewer (orthographic projection).
 *   `view` is a 3x3 rotation matrix (row-major) mapping world -> view.
 *
 * Sizes are in "surface pixels": 1px on the surface == 1px on screen at the
 * point of the sphere facing the viewer (sphere radius = 300px).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const RADIUS = 300;          // 600px diameter sphere
  const VIEW = 760;            // canvas size in CSS px (room for the atmosphere)
  const C = VIEW / 2;
  const GRID = 12;             // invisible 12 x 12 placement grid
  const STEP = 1 / 120;        // fixed simulation step (s)
  const MAX_STEPS_PER_FRAME = 40;
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const LEVELS = 16;           // shading buckets for batched drawing
  const GOAL = 100;            // seconds the ecosystem must survive
  const BEST_KEY = 'ceralis-best';

  const SPECIES = {
    cubebell: { name: 'Cubebells', size: 35, rgb: [64, 140, 255] },
    butterblock: { name: 'Butterblocks', size: 25, rgb: [242, 201, 76] },
    rubytile: { name: 'Rubytiles', size: 15, rgb: [235, 64, 52] },
  };

  // Contact = centers closer than half the two sizes combined (angular, on the unit sphere).
  const BUTTER_BELL_ANGLE = (SPECIES.cubebell.size + SPECIES.butterblock.size) / 2 / RADIUS;
  const RUBY_BUTTER_ANGLE = (SPECIES.butterblock.size + SPECIES.rubytile.size) / 2 / RADIUS;
  const COS_BUTTER_BELL = Math.cos(BUTTER_BELL_ANGLE);
  const COS_RUBY_BUTTER = Math.cos(RUBY_BUTTER_ANGLE);

  // Spatial hash for Rubytile -> Butterblock lookups. Cells must be at least the contact distance.
  const HASH_CELL = RUBY_BUTTER_ANGLE * 1.2;

  // Death animations.
  const EFFECT_LIFE = { burst: 0.45, wither: 0.6 }; // seconds (simulation time)
  const MAX_EFFECTS = 400;

  // ----------------------------------------------------------------- settings
  // Every ecosystem value starts random (unless it has a fixed `value`); RANDOM re-rolls them.
  // `random: false` excludes a control from RANDOM.
  const SETTINGS = [
    { key: 'cubebellCount', group: 'start', label: 'Count at start', species: 'cubebell', min: 0, max: 72, step: 1 },
    { key: 'butterCount', group: 'start', label: 'Count at start', species: 'butterblock', min: 0, max: 200, step: 1 },
    { key: 'rubyCount', group: 'start', label: 'Count at start', species: 'rubytile', min: 0, max: 200, step: 1 },
    { key: 'butterSpeed', group: 'live', label: 'Speed', species: 'butterblock', min: 0, max: 400, step: 5, fmt: v => `${v} px/s` },
    { key: 'rubySpeed', group: 'live', label: 'Speed', species: 'rubytile', min: 0, max: 800, step: 10, fmt: v => `${v} px/s` },
    { key: 'rubyStarve', group: 'live', label: 'Starves after', species: 'rubytile', min: 0, max: 5, step: 0.05, fmt: v => `${v.toFixed(2)}s` },
    { key: 'maxBugs', group: 'live', label: 'Max per species', min: 0, max: 3000, step: 50, value: 2500, random: false, hidden: true },
    { key: 'simSpeed', group: 'system', label: 'Sim speed', accent: '#fff', min: 0.25, max: 4, step: 0.25, value: 0.5, random: false, fmt: v => `${v}×` },
  ];
  /**
   * A random value on the slider's step grid. `spread` is the fraction of the
   * range to pick from, centered on the middle (1 = anywhere, 0.4 = 30%-70%).
   */
  function randomSetting(s, spread = 1) {
    const steps = Math.round((s.max - s.min) / s.step);
    const lo = Math.round(steps * (1 - spread) / 2);
    const hi = steps - lo;
    const n = lo + Math.floor(Math.random() * (hi - lo + 1));
    return Number((s.min + n * s.step).toFixed(4));
  }
  // First load: values near the middle of each slider so the opening ecosystem is balanced.
  // RANDOM still rolls across the full range.
  const FIRST_LOAD_SPREAD = 0.4;
  // Phones get a slower default sim so the small planet is easier to follow.
  const isPhone = window.matchMedia('(max-width: 760px)').matches;
  const settings = Object.fromEntries(SETTINGS.map(s => [s.key, s.value ?? randomSetting(s, FIRST_LOAD_SPREAD)]));
  if (isPhone) settings.simSpeed = 0.25;

  // ------------------------------------------------------------- vector math
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  function normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  }
  const apply = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
  function mul(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
      }
    }
    return r;
  }
  function rotX(t) { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function rotY(t) { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
  function orthonormalize(m) {
    const r0 = normalize([m[0], m[1], m[2]]);
    let r1 = [m[3], m[4], m[5]];
    const k = dot(r0, r1);
    r1 = normalize([r1[0] - r0[0] * k, r1[1] - r0[1] * k, r1[2] - r0[2] * k]);
    const r2 = cross(r0, r1);
    return [...r0, ...r1, ...r2];
  }

  function randomUnit(rand = Math.random) {
    const z = rand() * 2 - 1;
    const phi = rand() * TAU;
    const r = Math.sqrt(1 - z * z);
    return [r * Math.cos(phi), z, r * Math.sin(phi)];
  }
  function randomTangent(p) {
    for (;;) {
      const r = randomUnit();
      const k = dot(r, p);
      const t = [r[0] - p[0] * k, r[1] - p[1] * k, r[2] - p[2] * k];
      if (Math.hypot(t[0], t[1], t[2]) > 0.1) return normalize(t);
    }
  }
  function latLon(lat, lon) {
    const cl = Math.cos(lat);
    return [cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon)];
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Seeded RNG so the planet's surface markings and stars look the same every load.
  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------- grid
  /** Center of grid cell (row 0..11 from north, col 0..11 around) as a unit vector. */
  function gridToVector(row, col) {
    const lat = (90 - (row + 0.5) * (180 / GRID)) * DEG;
    const lon = (-180 + (col + 0.5) * (360 / GRID)) * DEG;
    return latLon(lat, lon);
  }

  // Cubebells may only grow on every other square (checkerboard): 72 spots.
  const CUBEBELL_SPOTS = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) if ((r + c) % 2 === 0) CUBEBELL_SPOTS.push([r, c]);
  }

  // ------------------------------------------------------------------ state
  let cubebells = [];
  let butterblocks = [];
  let rubytiles = [];
  const effects = [];
  let time = 0;

  // Game flow: title -> setup -> running -> over -> (reset) setup ...
  let phase = 'title';
  let paused = false;
  let cleared = false;   // reached the goal during this run
  let endTime = 0;       // when the ecosystem collapsed
  let extinct = [];      // species that died out
  let best = loadBest();

  function makeCubebell(row, col) {
    const p = gridToVector(row, col);
    const east = normalize(cross([0, 1, 0], p));
    const north = cross(p, east);
    return { p, u: east, v: north, row, col };
  }

  function makeBug(p, touching = -1) {
    return { p: [...p], d: randomTangent(p), omega: 0, hunger: 0, touching, dead: false, phase: Math.random() };
  }

  function touchedCubebell(p) {
    for (let i = 0; i < cubebells.length; i++) {
      if (dot(p, cubebells[i].p) > COS_BUTTER_BELL) return i;
    }
    return -1;
  }

  // Butterblocks bucketed by position so each Rubytile only checks nearby ones.
  const butterHash = new Map();
  const hashCell = v => Math.floor(v / HASH_CELL);
  const hashKey = (ix, iy, iz) => ((ix + 64) * 128 + (iy + 64)) * 128 + (iz + 64);

  function buildButterHash() {
    butterHash.clear();
    for (const b of butterblocks) {
      const k = hashKey(hashCell(b.p[0]), hashCell(b.p[1]), hashCell(b.p[2]));
      const bucket = butterHash.get(k);
      if (bucket) bucket.push(b); else butterHash.set(k, [b]);
    }
  }

  function findButterblock(p) {
    const ix = hashCell(p[0]), iy = hashCell(p[1]), iz = hashCell(p[2]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = butterHash.get(hashKey(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (const b of bucket) {
            if (!b.dead && dot(p, b.p) > COS_RUBY_BUTTER) return b;
          }
        }
      }
    }
    return null;
  }

  /** Rebuild the world from the starting sliders and return to setup. */
  function buildWorld() {
    time = 0;
    effects.length = 0;
    cubebells = shuffle([...CUBEBELL_SPOTS])
      .slice(0, settings.cubebellCount)
      .map(([r, c]) => makeCubebell(r, c));
    butterblocks = [];
    rubytiles = [];
    for (let i = 0; i < settings.butterCount; i++) {
      const p = randomUnit();
      butterblocks.push(makeBug(p, touchedCubebell(p)));
    }
    for (let i = 0; i < settings.rubyCount; i++) rubytiles.push(makeBug(randomUnit()));
  }

  // ------------------------------------------------------------- simulation
  /**
   * Move a bug along a great circle by `ang` radians, with a randomly
   * wandering heading (Ornstein-Uhlenbeck turn rate -> smooth random paths).
   */
  function advance(b, ang) {
    b.omega = b.omega * 0.97 + (Math.random() * 2 - 1) * 0.6;
    if (ang === 0) return;
    const turn = b.omega * STEP;
    const p = b.p, d = b.d;

    // Rotate heading around the surface normal.
    const ct = Math.cos(turn), st = Math.sin(turn);
    const qx = p[1] * d[2] - p[2] * d[1];
    const qy = p[2] * d[0] - p[0] * d[2];
    const qz = p[0] * d[1] - p[1] * d[0];
    let dx = d[0] * ct + qx * st, dy = d[1] * ct + qy * st, dz = d[2] * ct + qz * st;

    // Step forward along the great circle.
    const c = Math.cos(ang), s = Math.sin(ang);
    let px = p[0] * c + dx * s, py = p[1] * c + dy * s, pz = p[2] * c + dz * s;
    dx = dx * c - p[0] * s; dy = dy * c - p[1] * s; dz = dz * c - p[2] * s;

    // Renormalize to stop numerical drift.
    const pl = Math.hypot(px, py, pz);
    px /= pl; py /= pl; pz /= pl;
    const k = dx * px + dy * py + dz * pz;
    dx -= px * k; dy -= py * k; dz -= pz * k;
    const dl = Math.hypot(dx, dy, dz);
    p[0] = px; p[1] = py; p[2] = pz;
    d[0] = dx / dl; d[1] = dy / dl; d[2] = dz / dl;
  }

  // Events since the last frame, feeding the activity sound (see updateActivitySound).
  const events = { birth: 0, eat: 0, starve: 0 };

  function step() {
    time += STEP;

    // Butterblocks: divide whenever they touch a Cubebell (once per contact).
    const butterAng = (settings.butterSpeed / RADIUS) * STEP;
    const butterN = butterblocks.length;
    for (let i = 0; i < butterN; i++) {
      const b = butterblocks[i];
      advance(b, butterAng);
      const hit = touchedCubebell(b.p);
      if (hit >= 0 && hit !== b.touching && butterblocks.length < settings.maxBugs) {
        butterblocks.push(makeBug(b.p, hit));
        events.birth++;
      }
      b.touching = hit;
    }

    // Rubytiles: catching a Butterblock kills it and the Rubytile divides into two.
    // A Rubytile that goes longer than `rubyStarve` without eating dies.
    buildButterHash();
    const rubyAng = (settings.rubySpeed / RADIUS) * STEP;
    const born = [];
    let eaten = false;
    for (let i = rubytiles.length - 1; i >= 0; i--) {
      const r = rubytiles[i];
      advance(r, rubyAng);
      r.hunger += STEP;
      const prey = findButterblock(r.p);
      if (prey) {
        prey.dead = true;
        eaten = true;
        addEffect('burst', 'butterblock', prey);
        events.eat++;
        r.hunger = 0;
        if (rubytiles.length + born.length < settings.maxBugs) born.push(makeBug(r.p));
      } else if (r.hunger > settings.rubyStarve) {
        addEffect('wither', 'rubytile', r);
        events.starve++;
        rubytiles[i] = rubytiles[rubytiles.length - 1]; // swap-remove (already-visited element)
        rubytiles.pop();
      }
    }
    for (const b of born) rubytiles.push(b);
    if (eaten) butterblocks = butterblocks.filter(b => !b.dead);
  }

  // ---------------------------------------------------------- death effects
  /**
   * burst:  eaten Butterblock. An expanding outline plus shards flying outward.
   * wither: starved Rubytile. Shrinks, twists and fades to gray.
   * Effects live on the planet surface, so they rotate with it.
   */
  function addEffect(type, kind, bug) {
    if (effects.length >= MAX_EFFECTS) return;
    effects.push({
      type,
      kind,
      t0: time,
      p: [...bug.p],
      u: [...bug.d],
      v: cross(bug.p, bug.d),
      shards: type === 'burst'
        ? Array.from({ length: 6 }, (_, i) => ({ a: (i / 6) * TAU + Math.random() * 0.6, s: 0.7 + Math.random() * 0.6 }))
        : null,
    });
  }

  // ------------------------------------------------------------- game flow
  function loadBest() {
    try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
  }
  function recordBest(t) {
    if (t <= best) return;
    best = t;
    try { localStorage.setItem(BEST_KEY, String(best)); } catch { /* storage unavailable */ }
  }

  function reset() {
    if (phase === 'running') recordBest(time);
    phase = 'setup';
    paused = false;
    cleared = false;
    extinct = [];
    buildWorld();
    hideBanner();
    toast.hidden = true;
    refreshUI();
  }

  function launch() {
    if (phase !== 'setup') return;
    phase = 'running';
    paused = false;
    SFX.play('launch');
    checkOutcome(); // an empty species collapses the ecosystem immediately
    refreshUI();
  }

  function checkOutcome() {
    if (!cleared && time >= GOAL) {
      cleared = true;
      SFX.play('goal');
      showToast();
      refreshUI();
    }
    extinct = [];
    if (cubebells.length === 0) extinct.push('cubebell');
    if (butterblocks.length === 0) extinct.push('butterblock');
    if (rubytiles.length === 0) extinct.push('rubytile');
    if (extinct.length) {
      phase = 'over';
      endTime = time;
      recordBest(endTime);
      SFX.play('gameover');
      showBanner();
      refreshUI();
    }
  }

  function togglePause() {
    if (phase !== 'running') return;
    paused = !paused;
    SFX.play(paused ? 'pause' : 'resume');
    refreshUI();
  }

  // ---------------------------------------------------------------- canvas
  const canvas = document.getElementById('planet');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = VIEW * dpr;
  canvas.height = VIEW * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Light comes from the upper left, fixed relative to the viewer.
  const LIGHT = normalize([-0.38, 0.42, 0.82]);

  const atmosphereGlow = (() => {
    const g = ctx.createRadialGradient(C, C, RADIUS * 0.97, C, C, RADIUS * 1.14);
    g.addColorStop(0, 'rgba(228, 232, 238, 0.55)');
    g.addColorStop(0.25, 'rgba(214, 219, 226, 0.24)');
    g.addColorStop(1, 'rgba(200, 205, 212, 0)');
    return g;
  })();
  const bodyFill = (() => {
    const g = ctx.createRadialGradient(C - RADIUS * 0.38, C - RADIUS * 0.42, RADIUS * 0.05, C, C, RADIUS * 1.02);
    g.addColorStop(0, '#5f6268');
    g.addColorStop(0.45, '#393b3f');
    g.addColorStop(0.85, '#1c1d20');
    g.addColorStop(1, '#121315');
    return g;
  })();
  const limbHaze = (() => {
    const g = ctx.createRadialGradient(C, C, RADIUS * 0.78, C, C, RADIUS);
    g.addColorStop(0, 'rgba(222, 226, 233, 0)');
    g.addColorStop(1, 'rgba(222, 226, 233, 0.30)');
    return g;
  })();

  // Fixed surface markings so rotation is visible even when the planet is empty.
  const spots = (() => {
    const rand = mulberry32(7);
    return Array.from({ length: 48 }, () => ({
      c: randomUnit(rand),
      a: 0.03 + rand() ** 2 * 0.22,
      fill: rand() < 0.3 ? 'rgba(255, 255, 255, 0.035)' : 'rgba(0, 0, 0, 0.16)',
    }));
  })();

  let view = orthonormalize(mul(rotX(0.35), rotY(-0.3)));

  function drawSpots() {
    for (const s of spots) {
      const v = apply(view, s.c);
      if (v[2] < 0.03) continue;
      ctx.beginPath();
      ctx.ellipse(C + v[0] * RADIUS, C - v[1] * RADIUS,
        s.a * RADIUS * v[2], s.a * RADIUS, Math.atan2(-v[1], v[0]), 0, TAU);
      ctx.fillStyle = s.fill;
      ctx.fill();
    }
  }

  function drawGrid() {
    ctx.beginPath();
    const trace = fn => {
      let pen = false;
      for (let k = 0; k <= 120; k++) {
        const v = apply(view, fn(k / 120));
        if (v[2] > 0) {
          const x = C + v[0] * RADIUS, y = C - v[1] * RADIUS;
          if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          pen = true;
        } else {
          pen = false;
        }
      }
    };
    for (let i = 1; i < GRID; i++) {
      const lat = (90 - i * (180 / GRID)) * DEG;
      trace(t => latLon(lat, t * TAU));
    }
    for (let j = 0; j < GRID; j++) {
      const lon = (-180 + j * (360 / GRID)) * DEG;
      trace(t => latLon(-Math.PI / 2 + t * Math.PI, lon));
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Add a square of `size` surface px, centered at p with tangent axes u/v, to a shading bucket. */
  // ----------------------------------------------------------- sprites
  // Original 80s-arcade-style pixel art, one solid color per species.
  // Each sprite is drawn "facing up"; up maps to the creature's heading on
  // the sphere. '#' is filled, '.' is transparent.

  const SPRITE_ART = {
    cubebell: [
      [ // four-petal flower
        '....###....',
        '...#####...',
        '...#####...',
        '.##.###.##.',
        '###########',
        '###########',
        '###########',
        '.##.###.##.',
        '...#####...',
        '...#####...',
        '....###....',
      ],
    ],
    butterblock: [
      [ // wings open
        '...#...#...',
        '....#.#....',
        '###..#..###',
        '####.#.####',
        '###########',
        '.#########.',
        '..#######..',
        '.###.#.###.',
        '.##..#..##.',
      ],
      [ // wings folded
        '...#...#...',
        '....#.#....',
        '...#####...',
        '..#######..',
        '..#######..',
        '...#####...',
        '...#####...',
        '...#####...',
        '....###....',
      ],
    ],
    rubytile: [
      [ // wings out
        '..#...#..',
        '...###...',
        '##.###.##',
        '#########',
        '.#######.',
        '...###...',
        '...###...',
        '...###...',
        '....#....',
      ],
      [ // wings back
        '..#...#..',
        '...###...',
        '...###...',
        '.#######.',
        '.#######.',
        '..#####..',
        '...###...',
        '...###...',
        '....#....',
      ],
    ],
  };
  // On-screen size relative to the species' contact size (bugs drawn a bit larger to read).
  const SPRITE_SCALE = { cubebell: 1.05, butterblock: 1.35, rubytile: 1.6 };
  const FLAP_HZ = { cubebell: 0, butterblock: 1.5, rubytile: 9 };

  /** sprites[species][frame][lightLevel] -> small canvas, plus its pixel size. */
  const sprites = {};
  for (const [kind, frames] of Object.entries(SPRITE_ART)) {
    sprites[kind] = frames.map(rows => {
      const w = rows[0].length, h = rows.length;
      return Array.from({ length: LEVELS }, (_, i) => {
        const f = (i + 1) / LEVELS;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d');
        const img = g.createImageData(w, h);
        const { rgb } = SPECIES[kind];
        rows.forEach((row, y) => [...row].forEach((ch, x) => {
          if (ch === '.') return;
          const o = (y * w + x) * 4;
          img.data[o] = rgb[0] * f; img.data[o + 1] = rgb[1] * f; img.data[o + 2] = rgb[2] * f; img.data[o + 3] = 255;
        }));
        g.putImageData(img, 0, 0);
        return cv;
      });
    });
  }

  // Still (first-frame, full-brightness) sprite as each .chip icon in the UI.
  for (const kind of Object.keys(SPRITE_ART)) {
    const still = sprites[kind][0][LEVELS - 1].toDataURL();
    document.documentElement.style.setProperty(`--icon-${kind}`, `url("${still}")`);
  }

  /**
   * Draw a sprite on the sphere at `p`, its "up" along tangent `fwd`.
   * The affine transform maps the sprite onto the projected tangent plane,
   * so it foreshortens naturally toward the limb.
   */
  function drawSprite(kind, p, fwd, frame) {
    const vp = apply(view, p);
    if (vp[2] < 0.03) return; // back side of the planet
    const vf = apply(view, fwd), vs = apply(view, cross(p, fwd));
    const lambert = Math.max(0, dot(vp, LIGHT));
    const level = Math.min(LEVELS - 1, Math.round((0.3 + 0.7 * lambert) * (LEVELS - 1)));
    const img = sprites[kind][frame][level];
    const size = SPECIES[kind].size * SPRITE_SCALE[kind];
    const W = size * (img.width / Math.max(img.width, img.height));
    const H = size * (img.height / Math.max(img.width, img.height));
    ctx.setTransform(
      -W * vs[0] * dpr, W * vs[1] * dpr,
      -H * vf[0] * dpr, H * vf[1] * dpr,
      (C + vp[0] * RADIUS) * dpr, (C - vp[1] * RADIUS) * dpr,
    );
    ctx.drawImage(img, -0.5, -0.5, 1, 1);
  }

  function drawLife() {
    const now = performance.now() / 1000;
    const frameOf = (kind, b) => (FLAP_HZ[kind] ? Math.floor(now * FLAP_HZ[kind] * 2 + b.phase * 2) & 1 : 0);
    ctx.imageSmoothingEnabled = false; // crisp pixels
    for (const c of cubebells) drawSprite('cubebell', c.p, c.v, 0);
    for (const b of butterblocks) drawSprite('butterblock', b.p, b.d, frameOf('butterblock', b));
    for (const r of rubytiles) drawSprite('rubytile', r.p, r.d, frameOf('rubytile', r));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }
  function quadPath(vp, vu, vv, ox, oy, half, angle) {
    const ca = Math.cos(angle) * half, sa = Math.sin(angle) * half;
    const bx = C + vp[0] * RADIUS, by = C - vp[1] * RADIUS;
    ctx.beginPath();
    for (const [su, sv] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const a = ox + su * ca - sv * sa;
      const b = oy + su * sa + sv * ca;
      ctx.lineTo(bx + vu[0] * a + vv[0] * b, by - (vu[1] * a + vv[1] * b));
    }
    ctx.closePath();
  }

  const rgba = (rgb, f, alpha) =>
    `rgba(${Math.round(rgb[0] * f)}, ${Math.round(rgb[1] * f)}, ${Math.round(rgb[2] * f)}, ${alpha.toFixed(3)})`;

  function drawEffects() {
    let keep = 0;
    for (const e of effects) {
      const age = (time - e.t0) / EFFECT_LIFE[e.type];
      if (age >= 1) continue;
      effects[keep++] = e;

      const vp = apply(view, e.p);
      if (vp[2] < 0.03) continue; // back side of the planet
      const vu = apply(view, e.u), vv = apply(view, e.v);
      const light = 0.3 + 0.7 * Math.max(0, dot(vp, LIGHT));
      const { rgb, size } = SPECIES[e.kind];
      const fade = 1 - age;

      if (e.type === 'burst') {
        const out = 1 - fade ** 3; // ease-out
        quadPath(vp, vu, vv, 0, 0, (size / 2) * (1 + 1.6 * out), out * 0.8);
        ctx.strokeStyle = rgba(rgb, light, fade * 0.9);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = rgba(rgb, light, fade);
        for (const s of e.shards) {
          const d = size * (0.2 + 1.4 * out * s.s);
          quadPath(vp, vu, vv, Math.cos(s.a) * d, Math.sin(s.a) * d, 1 + size * 0.14 * fade, s.a + out * 3);
          ctx.fill();
        }
      } else {
        const gray = 130;
        const mixed = rgb.map(c => c + (gray - c) * age);
        quadPath(vp, vu, vv, 0, 0, (size / 2) * (1 - 0.8 * age), age * Math.PI * 0.75);
        ctx.fillStyle = rgba(mixed, light, fade);
        ctx.fill();
      }
    }
    effects.length = keep;
  }

  function render() {
    ctx.clearRect(0, 0, VIEW, VIEW);

    // Outer atmosphere glow.
    ctx.beginPath();
    ctx.arc(C, C, RADIUS * 1.14, 0, TAU);
    ctx.fillStyle = atmosphereGlow;
    ctx.fill();

    // Planet body + everything on its surface.
    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, RADIUS, 0, TAU);
    ctx.clip();
    ctx.fillStyle = bodyFill;
    ctx.fillRect(C - RADIUS, C - RADIUS, RADIUS * 2, RADIUS * 2);
    drawSpots();
    if (showGrid.checked) drawGrid();
    drawLife();
    drawEffects();
    ctx.fillStyle = limbHaze; // atmosphere seen edge-on over the surface
    ctx.fillRect(C - RADIUS, C - RADIUS, RADIUS * 2, RADIUS * 2);
    ctx.restore();

    // Thin bright rim.
    ctx.beginPath();
    ctx.arc(C, C, RADIUS, 0, TAU);
    ctx.strokeStyle = 'rgba(236, 239, 243, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Goal reached: teal ring around the planet.
    if (cleared) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(C, C, RADIUS * 1.06, 0, TAU);
      ctx.strokeStyle = 'rgb(0, 214, 214)';
      ctx.lineWidth = 4;
      ctx.shadowColor = 'rgba(0, 214, 214, 0.8)';
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.restore();
    }
  }

  // ----------------------------------------------------------------- stars
  const starCanvas = document.getElementById('stars');
  function drawStars() {
    const w = window.innerWidth, h = window.innerHeight;
    const sctx = starCanvas.getContext('2d');
    starCanvas.width = w * dpr;
    starCanvas.height = h * dpr;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.fillStyle = '#000';
    sctx.fillRect(0, 0, w, h);
    const rand = mulberry32(42);
    const count = Math.round((w * h) / 9000);
    for (let i = 0; i < count; i++) {
      const r = rand() < 0.92 ? 0.4 + rand() * 0.5 : 0.9 + rand() * 0.6;
      sctx.globalAlpha = 0.25 + rand() * 0.7;
      sctx.fillStyle = '#fff';
      sctx.beginPath();
      sctx.arc(rand() * w, rand() * h, r, 0, TAU);
      sctx.fill();
    }
    sctx.globalAlpha = 1;
  }
  drawStars();
  window.addEventListener('resize', drawStars);

  // ------------------------------------------------------------ rotation UI
  const autoRotate = document.getElementById('auto-rotate');
  const showGrid = document.getElementById('show-grid');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) autoRotate.checked = false;
  autoRotate.addEventListener('change', () => SFX.play('toggle'));

  const soundToggle = document.getElementById('sound');
  soundToggle.checked = SFX.enabled;
  soundToggle.addEventListener('change', () => {
    SFX.enabled = soundToggle.checked;
    SFX.play('toggle'); // confirms "on"; silent when turning off
  });

  let dragging = false;
  let lastX = 0, lastY = 0, lastMove = 0;
  let spinX = 0, spinY = 0; // inertial angular velocity (rad/s)

  function rotateView(ax, ay) {
    view = orthonormalize(mul(rotX(ay), mul(rotY(ax), view)));
  }

  canvas.addEventListener('pointerdown', e => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    lastX = e.clientX; lastY = e.clientY; lastMove = e.timeStamp;
    spinX = spinY = 0;
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const scale = VIEW / canvas.getBoundingClientRect().width;
    const ax = ((e.clientX - lastX) * scale) / RADIUS;
    const ay = ((e.clientY - lastY) * scale) / RADIUS;
    rotateView(ax, ay);
    const dt = Math.max(1, e.timeStamp - lastMove) / 1000;
    const clamp = v => Math.max(-6, Math.min(6, v));
    spinX = clamp(ax / dt); spinY = clamp(ay / dt);
    lastX = e.clientX; lastY = e.clientY; lastMove = e.timeStamp;
  });
  const endDrag = e => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    if (e.timeStamp - lastMove > 80) spinX = spinY = 0; // released without flicking
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Arrows rotate when the planet has focus (elsewhere they move sliders).
  canvas.addEventListener('keydown', e => {
    const k = 0.1;
    switch (e.key) {
      case 'ArrowLeft': rotateView(-k, 0); break;
      case 'ArrowRight': rotateView(k, 0); break;
      case 'ArrowUp': rotateView(0, -k); break;
      case 'ArrowDown': rotateView(0, k); break;
      default: return;
    }
    e.preventDefault();
  });

  // Space pauses and R resets anywhere in the game (Space still presses a focused button).
  document.addEventListener('keydown', e => {
    if (phase === 'title' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && e.target.tagName !== 'BUTTON') {
      togglePause();
      e.preventDefault();
    } else if (e.key === 'r' || e.key === 'R') {
      SFX.play('reset');
      reset();
    }
  });

  function updateRotation(dt) {
    if (dragging) return;
    if (Math.abs(spinX) + Math.abs(spinY) > 1e-3) {
      rotateView(spinX * dt, spinY * dt);
      const decay = Math.exp(-2.5 * dt);
      spinX *= decay; spinY *= decay;
    }
    if (autoRotate.checked) {
      view = mul(view, rotY(0.15 * dt)); // spin about the planet's own axis
    }
  }

  // ------------------------------------------------------------- controls UI
  const sliders = {};

  function buildControls() {
    for (const s of SETTINGS) {
      const id = `ctl-${s.key}`;
      const wrap = document.createElement('div');
      wrap.className = 'control';
      wrap.hidden = !!s.hidden;
      const accent = s.accent || (s.species && `var(--${s.species})`);
      if (accent) wrap.style.setProperty('--accent', accent);
      wrap.innerHTML = `
        <label for="${id}"><span>${s.label}</span><output for="${id}"></output></label>
        <input type="range" id="${id}" min="${s.min}" max="${s.max}" step="${s.step}" value="${settings[s.key]}">`;
      const input = wrap.querySelector('input');
      const out = wrap.querySelector('output');
      const fmt = s.fmt || (v => String(v));
      const sync = () => {
        settings[s.key] = Number(input.value);
        out.textContent = fmt(settings[s.key]);
        input.style.setProperty('--pct', `${((settings[s.key] - s.min) / (s.max - s.min)) * 100}%`);
      };
      input.addEventListener('input', () => {
        sync();
        SFX.play('tick');
        if (s.group === 'start' && phase === 'setup') { buildWorld(); refreshUI(); }
        else if (s.group === 'start') refreshUI();
      });
      sync();
      sliders[s.key] = { input, sync };
      // Each species gets its own section; anything else goes under SYSTEM.
      document.getElementById(s.species ? `controls-${s.species}` : 'controls-system').append(wrap);
    }
  }
  buildControls();

  /** Fill every ecosystem slider with a random value, then rebuild the world. */
  function randomize() {
    for (const s of SETTINGS) {
      if (s.random === false) continue;
      sliders[s.key].input.value = String(randomSetting(s));
      sliders[s.key].sync();
    }
    reset();
  }

  const titleScreen = document.getElementById('title-screen');
  const game = document.getElementById('game');
  const randomBtn = document.getElementById('random');
  const primaryBtn = document.getElementById('primary');
  const pauseBtn = document.getElementById('pause');
  const banner = document.getElementById('banner');
  const bannerTitle = document.getElementById('banner-title');
  const bannerSub = document.getElementById('banner-sub');
  const bannerBtn = document.getElementById('banner-btn');
  const toast = document.getElementById('toast');
  const messageEl = document.getElementById('message');
  const hudTime = document.getElementById('hud-time');
  const hudBest = document.getElementById('hud-best');
  const progressFill = document.getElementById('progress-fill');
  const statEls = {
    cubebell: document.getElementById('stat-cubebell'),
    butterblock: document.getElementById('stat-butterblock'),
    rubytile: document.getElementById('stat-rubytile'),
  };
  // Compact status shown beside the planet on phones while the menu is hidden.
  const miniPause = document.getElementById('mini-pause');
  const miniEls = {
    cubebell: document.getElementById('mini-cubebell'),
    butterblock: document.getElementById('mini-butterblock'),
    rubytile: document.getElementById('mini-rubytile'),
  };
  const miniSet = Object.fromEntries(
    ['start-cubebell', 'start-butterblock', 'start-rubytile', 'butter-speed', 'ruby-speed', 'ruby-starve', 'sim']
      .map(k => [k, document.getElementById(`mini-${k}`)]));
  const panelMessage = document.getElementById('panel-message');
  miniPause.addEventListener('click', togglePause);

  document.getElementById('start-game').addEventListener('click', () => {
    titleScreen.hidden = true;
    document.body.classList.remove('on-title');
    game.inert = false;
    SFX.play('launch');
    reset();
    randomBtn.focus();
  });
  randomBtn.addEventListener('click', () => { SFX.play('random'); randomize(); });
  primaryBtn.addEventListener('click', () => {
    if (phase !== 'setup') { SFX.play('reset'); reset(); return; }
    launch();
    // On narrow screens the panel sits below the planet; jump back up to watch.
    const stage = document.querySelector('.stage');
    if (stage.getBoundingClientRect().top < 0) {
      const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
    }
  });
  pauseBtn.addEventListener('click', togglePause);
  bannerBtn.addEventListener('click', () => { SFX.play('retry'); reset(); primaryBtn.focus(); });

  function showBanner() {
    const t = endTime.toFixed(1);
    const names = extinct.map(k => SPECIES[k].name.toUpperCase());
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    if (cleared) {
      banner.classList.add('win');
      bannerTitle.textContent = 'STAGE CLEAR!';
      bannerSub.textContent = `Your ecosystem lasted ${t}s before the ${who} died out.`;
      bannerBtn.textContent = 'PLAY AGAIN';
    } else {
      banner.classList.remove('win');
      bannerTitle.textContent = 'GAME OVER';
      bannerSub.textContent = `The ${who} died out at ${t}s.`;
      bannerBtn.textContent = 'TRY AGAIN';
    }
    toast.hidden = true;
    banner.hidden = false;
  }
  function hideBanner() { banner.hidden = true; }

  let toastTimer = 0;
  function showToast() {
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2500);
  }

  const pad = t => t.toFixed(1).padStart(5, '0');

  /** Buttons and message that only change with the game phase. */
  function refreshUI() {
    primaryBtn.textContent = phase === 'setup' ? 'START' : 'RESET';
    pauseBtn.disabled = phase !== 'running';
    pauseBtn.textContent = paused ? 'RESUME' : 'PAUSE';
    miniPause.textContent = pauseBtn.textContent;
    miniPause.disabled = pauseBtn.disabled;
    game.dataset.phase = phase;
    miniSet['start-cubebell'].textContent = `/${settings.cubebellCount}`;
    miniSet['start-butterblock'].textContent = `/${settings.butterCount}`;
    miniSet['butter-speed'].textContent = `${settings.butterSpeed}px/s`;
    miniSet['start-rubytile'].textContent = `/${settings.rubyCount}`;
    miniSet['ruby-speed'].textContent = `${settings.rubySpeed}px/s`;
    miniSet['ruby-starve'].textContent = `STARVE ${settings.rubyStarve.toFixed(2)}s`;
    miniSet.sim.textContent = `SIM ${settings.simSpeed}×`;
    let msg = '';
    if (phase === 'setup') {
      const empty = SETTINGS.every(s => s.random === false || settings[s.key] === 0);
      msg = empty ? 'PRESS RANDOM OR SET THE SLIDERS' : 'PRESS START TO LAUNCH YOUR ECOSYSTEM';
    } else if (phase === 'running') {
      msg = paused ? 'PAUSED' : cleared ? 'GOAL REACHED! HOW LONG CAN IT LAST?' : 'KEEP ALL 3 SPECIES ALIVE';
    } else if (phase === 'over') {
      msg = 'PRESS RESET TO TRY AGAIN';
    }
    messageEl.textContent = msg;
    panelMessage.textContent = msg;
    updateHud(true);
  }

  let lastHud = 0;
  function updateHud(force = false) {
    const now = performance.now();
    if (!force && now - lastHud < 100) return;
    lastHud = now;
    const t = phase === 'over' ? endTime : time;
    hudTime.textContent = pad(t);
    hudBest.textContent = pad(Math.max(best, phase === 'running' ? time : 0));
    progressFill.style.width = `${Math.min(1, t / GOAL) * 100}%`;
    progressFill.classList.toggle('cleared', cleared);
    statEls.cubebell.textContent = cubebells.length;
    statEls.butterblock.textContent = butterblocks.length;
    statEls.rubytile.textContent = rubytiles.length;
    miniEls.cubebell.textContent = cubebells.length;
    miniEls.butterblock.textContent = butterblocks.length;
    miniEls.rubytile.textContent = rubytiles.length;
  }

  // ---------------------------------------------------------- activity sound
  // Light boops while the ecosystem runs. The boop rate follows a smoothed
  // events-per-second figure on a log scale: a busy planet gets more boops,
  // a quiet one fewer, and it never exceeds ACTIVITY_MAX_RATE.
  const ACTIVITY_MAX_RATE = 6;   // boops per second at most
  let activity = 0;              // smoothed events per real second
  let boopBudget = 0;
  const recent = { birth: 0, eat: 0, starve: 0 };

  function updateActivitySound(dt) {
    const n = events.birth + events.eat + events.starve;
    for (const k in events) { recent[k] = recent[k] * 0.9 + events[k]; events[k] = 0; }
    if (phase !== 'running' || paused || dt <= 0) { activity = 0; boopBudget = 0; return; }

    const k = 1 - Math.exp(-dt / 0.6); // ~0.6s smoothing
    activity += (n / dt - activity) * k;

    const rate = Math.min(ACTIVITY_MAX_RATE, 1.3 * Math.log2(1 + activity / 3));
    boopBudget += rate * dt;
    if (boopBudget < 1) return;
    boopBudget -= 1 + (Math.random() - 0.5) * 0.4; // jitter so it doesn't tick like a metronome

    // Pick the boop type in proportion to what has been happening.
    const total = recent.birth + recent.eat + recent.starve;
    if (total <= 0) return;
    let pick = Math.random() * total;
    const kind = (pick -= recent.birth) < 0 ? 'birth' : (pick -= recent.eat) < 0 ? 'eat' : 'starve';
    SFX.play(`boop-${kind}`, Math.min(1, 0.4 + rate / ACTIVITY_MAX_RATE));
  }

  // -------------------------------------------------------------- main loop
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    updateRotation(dt);
    // After a collapse the survivors keep moving, but the clock is frozen at endTime.
    if ((phase === 'running' || phase === 'over') && !paused) {
      acc += dt * settings.simSpeed;
      let n = 0;
      while (acc >= STEP && n < MAX_STEPS_PER_FRAME) {
        step();
        if (phase === 'running') checkOutcome();
        acc -= STEP;
        n++;
      }
      if (n === MAX_STEPS_PER_FRAME) acc = 0; // fell behind; drop the backlog
    } else {
      acc = 0;
    }
    updateActivitySound(dt);
    render();
    updateHud();
    requestAnimationFrame(frame);
  }

  buildWorld();
  refreshUI();
  requestAnimationFrame(frame);

  // Small API for placing/inspecting things from the console.
  window.ceralis = {
    GRID,
    gridToVector,
    get state() { return { phase, cubebells, butterblocks, rubytiles, time, settings }; },
    reset,
    launch,
    randomize,
  };
})();
