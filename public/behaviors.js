// Creature behaviours on top of the motion in aquarium.js: random dashes for
// every species, one special per species (shark bite, squid ink, fish flight,
// turtle breath, jellyfish glow, ray flip, seahorse spin and bubbles), and the
// effects they leave in the water.
// aquarium.js calls update() once per frame after the creatures have moved.
// An action takes over the velocity for its length (setVel). Changes to the
// drawn shape go through c.beh.sx / c.beh.sy, and c.beh.extra is extra tail wave
// time, so the tail beats faster during a dash.

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const bump = (u) => Math.sin(Math.PI * clamp(u, 0, 1)); // 0 at both ends, 1 in the middle
// Keeps the sign of a scale but never lets it reach zero (a zero scale draws nothing).
const squash = (v) => (v < 0 ? -1 : 1) * Math.max(0.05, Math.abs(v));
// Unit vector of (x, y), or the fallback direction (fx, 0) when it is too short.
const unitOr = (x, y, fx) => {
  const l = Math.hypot(x, y);
  return l > 4 ? [x / l, y / l] : [fx, 0];
};

const DASH_GAP = [8, 20]; // seconds between random dashes
const SPECIAL = { shark: 'bite', squid: 'ink', turtle: 'breathe', jellyfish: 'glow', ray: 'flip', seahorse: 'spin' };
const SPECIAL_GAP = { shark: [10, 18], squid: [18, 35], turtle: [14, 26], jellyfish: [12, 22], ray: [14, 24], seahorse: [14, 26] };
const GENTLE = new Set(['jellyfish', 'seahorse']); // smaller, slower dashes
const ALARM_COOLDOWN = 5; // seconds before a creature can be startled again
const TRAIL_SECONDS = 0.7;
const INK_SECONDS = 3.5;
const FLASH_SECONDS = 0.35;
const MAX_PUFFS = 160;

export function createBehaviors({ creatures, depth, persp, screenW, screenH, yBounds }) {
  let W = 0;
  let H = 0;
  let puffs = []; // bubbles rising through the water
  let inks = []; // ink clouds
  let flashes = []; // bite flashes at a shark's mouth

  const speedOf = (c) => c.baseSpeed * persp(c.d); // cruise speed at the creature's depth
  const heading = (c) => unitOr(c.vx, c.vy, c.f);
  // A point on the creature. fx and fy are fractions of its drawn size from its
  // centre; fx is mirrored with its facing.
  const at = (c, fx, fy) => ({ x: c.x + c.f * screenW(c) * fx, y: c.y + screenH(c) * fy });

  // Per-creature state, made the first time the creature has a sprite.
  function stateOf(c) {
    if (!c.beh) {
      c.beh = {
        gap: rand(...DASH_GAP), // seconds until the next random dash
        special: SPECIAL[c.species] ? rand(...SPECIAL_GAP[c.species]) : Infinity,
        run: null, // movement in progress: dash, chase or rise (see stepRun)
        act: null, // timed change of shape or glow, no movement of its own
        alarmCd: 0, // seconds before this creature can be startled again
        trail: [], // wake points behind a dash
        sx: 1, // drawn scale, reset every frame (see drawCreature)
        sy: 1,
        extra: 0,
      };
    }
    return c.beh;
  }

  // Sets the velocity for this frame, but never pushes into the sand or the surface.
  function setVel(c, vx, vy) {
    const [lo, hi] = yBounds(c);
    if (c.y <= lo + 1 && vy < 0) vy = 0;
    if (c.y >= hi - 1 && vy > 0) vy = 0;
    c.vx = vx;
    c.vy = vy;
  }

  // A bubble of the given size at depth d, rising from (x, y).
  function puff(x, y, d, size, delay = 0) {
    puffs.push({
      x,
      y,
      r: size * persp(d) * rand(0.7, 1.2),
      rise: rand(50, 100) * (H / 1080),
      phase: rand(0, TAU),
      sway: rand(4, 10),
      t: 0,
      life: rand(1.6, 2.6),
      delay,
      fog: depth.fogAt(d),
    });
    if (puffs.length > MAX_PUFFS) puffs.splice(0, puffs.length - MAX_PUFFS);
  }

  // A few bubbles at once.
  function burst(x, y, d, count) {
    for (let i = 0; i < count; i++) puff(x + rand(-10, 10) * persp(d), y + rand(-6, 6) * persp(d), d, 3);
  }

  // A short chain of bubbles, one after another, from (x, y).
  function chain(x, y, d, n) {
    for (let i = 0; i < n; i++) puff(x + rand(-3, 3) * persp(d), y, d, 4 + i * 0.7, i * 0.22);
  }

  // A burst along (dx, dy): the speed goes from base up to peak and back (see stepRun).
  function dashRun(c, b, dx, dy, base, peak, dur) {
    b.run = { kind: 'dash', t: 0, dur, dx, dy, base, peak, trailT: 0 };
    const tail = at(c, -0.4, 0);
    burst(tail.x, tail.y, c.d, 3);
  }

  function randomDash(c, b) {
    let [dx, dy] = heading(c);
    if (Math.random() < 0.35) {
      // A quick sideways dodge, to the left or to the right of the heading.
      const s = Math.random() < 0.5 ? 1 : -1;
      [dx, dy] = [-dy * s, dx * s];
    }
    const gentle = GENTLE.has(c.species);
    const base = speedOf(c);
    const mult = gentle ? rand(1.8, 2.2) : rand(3, 4);
    dashRun(c, b, dx, dy, base, base * mult, gentle ? rand(0.5, 0.7) : rand(0.4, 0.8));
    b.gap = rand(...DASH_GAP);
  }

  // Startles the fish and squids near (x, y) at depth d. Fish dart away from the
  // point; squids release ink and jet away. Returns how many were startled.
  function alarm(x, y, radius, d, except) {
    let n = 0;
    for (const o of creatures.values()) {
      if (o === except || o.state !== 'alive' || !o.sprite) continue;
      if (o.species !== 'fish' && o.species !== 'squid') continue;
      const b = stateOf(o);
      if (b.alarmCd > 0 || Math.hypot(o.x - x, o.y - y) > radius || Math.abs(o.d - d) > 0.25) continue;
      const [ax, ay] = unitOr(o.x - x, o.y - y, Math.random() < 0.5 ? 1 : -1);
      b.alarmCd = ALARM_COOLDOWN;
      if (o.species === 'squid') inkRelease(o, b, ax, ay);
      else dashRun(o, b, ax, ay, speedOf(o), speedOf(o) * rand(3, 4), rand(0.5, 0.7));
      n++;
    }
    return n;
  }

  // Ink cloud behind the squid, and a jet along (jx, jy).
  function inkRelease(c, b, jx, jy) {
    const s = screenW(c);
    const p = at(c, -0.05, 0);
    inks.push({
      x: p.x,
      y: p.y,
      vx: rand(-8, 8) * (H / 1080),
      vy: rand(-4, 4) * (H / 1080),
      t: 0,
      fog: depth.fogAt(c.d),
      blobs: Array.from({ length: 7 }, () => ({
        ox: rand(-0.5, 0.5) * s,
        oy: rand(-0.3, 0.3) * s,
        r: s * rand(0.18, 0.3),
      })),
    });
    dashRun(c, b, jx, jy, speedOf(c), speedOf(c) * 4, 0.7);
  }

  // The closest smaller creature at a similar depth. With relaxed, any smaller creature.
  function findPrey(c, relaxed) {
    let best = null;
    let bestDx = Infinity;
    for (const o of creatures.values()) {
      if (o === c || o.state !== 'alive' || !o.sprite || o.motion.size >= c.motion.size) continue;
      const dx = Math.abs(o.x - c.x);
      if (!relaxed && (dx > W * 0.4 || Math.abs(o.d - c.d) > 0.12)) continue;
      if (!best || dx < bestDx) {
        best = o;
        bestDx = dx;
      }
    }
    return best;
  }

  function startBite(c, b, relaxed) {
    const prey = findPrey(c, relaxed);
    if (!prey) return false;
    b.run = { kind: 'chase', t: 0, dur: 3, prey };
    return true;
  }

  // Jaws snap shut: a white flash and bubbles at the mouth, the prey darts away
  // from the shark, and the shark lunges on with a chomp.
  function snap(c, b, prey, ux, uy) {
    const m = at(c, 0.45, 0.12);
    const pb = stateOf(prey);
    flashes.push({ x: m.x, y: m.y, dir: c.f, t: 0, size: screenH(c) * 0.5 });
    burst(m.x, m.y, c.d, 6);
    pb.alarmCd = ALARM_COOLDOWN;
    dashRun(prey, pb, ux, uy, speedOf(prey), speedOf(prey) * rand(3.5, 4.5), rand(0.7, 0.9));
    alarm(m.x, m.y, W * 0.15, c.d, c);
    dashRun(c, b, ux, uy, speedOf(c) * 3.2, speedOf(c) * 3.6, 0.35);
    b.act = { kind: 'chomp', t: 0, dur: 0.4 };
  }

  function startSpecial(c, b) {
    switch (SPECIAL[c.species]) {
      case 'bite':
        return startBite(c, b, false);
      case 'ink': {
        const [hx, hy] = heading(c);
        inkRelease(c, b, -hx, -hy);
        return true;
      }
      case 'breathe':
        b.run = { kind: 'rise', t: 0, dur: 5.5, yUp: yBounds(c)[0] + H * 0.02, puffT: 0 };
        return true;
      case 'glow':
        b.act = { kind: 'glow', t: 0, dur: rand(1.8, 2.4) };
        return true;
      case 'flip': {
        const [hx, hy] = heading(c);
        dashRun(c, b, hx, hy, speedOf(c), speedOf(c) * 2.5, 1.1);
        b.act = { kind: 'flip', t: 0, dur: 1.1 };
        return true;
      }
      case 'spin': {
        b.act = { kind: 'spin', t: 0, dur: 1.6 };
        const m = at(c, 0.21, -0.33); // the snout
        chain(m.x, m.y, c.d, 7);
        return true;
      }
    }
    return false;
  }

  // Moves a creature for its current run. Each run sets the velocity for the
  // frame; when it ends, the creature's own steering eases it back.
  function stepRun(c, b, dt) {
    const r = b.run;
    r.t += dt;
    const u = r.t / r.dur;
    if (u >= 1) {
      b.run = null;
      return;
    }
    if (r.kind === 'dash') {
      const env = Math.sin(Math.PI * Math.min(1, u * 1.25)); // quick start, easing back
      const sp = r.base + (r.peak - r.base) * env;
      setVel(c, r.dx * sp, r.dy * sp);
      b.extra += dt * 2 * env;
      if (GENTLE.has(c.species)) {
        b.sx *= 1 - 0.03 * env;
        b.sy *= 1 + 0.05 * env;
      }
      r.trailT -= dt;
      if (env > 0.2 && r.trailT <= 0) {
        r.trailT = 0.04;
        const tail = at(c, -0.45, 0); // the wake starts behind the body, so it shows
        b.trail.push({ x: tail.x, y: tail.y, life: TRAIL_SECONDS, w: screenH(c) * 0.26 });
      }
    } else if (r.kind === 'chase') {
      const prey = r.prey;
      if (creatures.get(prey.id) !== prey || prey.state !== 'alive') {
        b.run = null;
        return;
      }
      const dx = prey.x - c.x;
      const dy = prey.y - c.y;
      const dist = Math.hypot(dx, dy) || 1;
      // Snap only when the shark faces the prey, so the mouth is on the prey's side.
      if (dist < screenW(c) * 0.5 && Math.sign(c.f) === Math.sign(dx)) {
        snap(c, b, prey, dx / dist, dy / dist);
        return;
      }
      const sp = speedOf(c) * 3.2;
      setVel(c, (dx / dist) * sp, (dy / dist) * sp);
    } else if (r.kind === 'rise') {
      // Up to the surface, a stream of bubbles from the mouth, then back to normal.
      if (u < 0.7) setVel(c, c.vx, clamp((r.yUp - c.y) * 2.5, -H * 0.3, H * 0.3));
      r.puffT -= dt;
      if (u > 0.2 && u < 0.7 && r.puffT <= 0) {
        r.puffT = 0.14;
        const m = at(c, 0.35, 0);
        puff(m.x, m.y, c.d, 3);
      }
    }
  }

  // Shape changes of timed actions: the chomp, the ray's flip and the seahorse's spin.
  function scaleAct(b) {
    const a = b.act;
    const u = a.t / a.dur;
    if (a.kind === 'chomp') {
      const k = bump(u);
      b.sx *= 1 + 0.14 * k;
      b.sy *= 1 - 0.1 * k;
    } else if (a.kind === 'flip') {
      b.sy *= squash(Math.cos(TAU * u));
    } else if (a.kind === 'spin') {
      b.sx *= squash(Math.cos(TAU * u));
    }
  }

  function stepCreature(c, dt) {
    const b = stateOf(c);
    b.sx = 1;
    b.sy = 1;
    b.alarmCd = Math.max(0, b.alarmCd - dt);
    b.trail = b.trail.filter((p) => (p.life -= dt) > 0);
    if (b.act) {
      b.act.t += dt;
      if (b.act.t >= b.act.dur) b.act = null;
      else scaleAct(b);
    }
    if (c.state === 'leave') {
      b.run = null;
      return;
    }
    if (b.run) stepRun(c, b, dt);
    if (c.state !== 'alive') return;
    if (c.species === 'shark' && b.alarmCd <= 0) {
      // A shark close by startles the fish and squids near it.
      alarm(c.x, c.y, W * 0.18, c.d, c);
      b.alarmCd = 1;
    }
    if (b.run) return;
    b.gap -= dt;
    b.special -= dt;
    if (b.special <= 0) b.special = startSpecial(c, b) ? rand(...SPECIAL_GAP[c.species]) : 3;
    else if (b.gap <= 0) randomDash(c, b);
  }

  function stepEffects(dt) {
    puffs = puffs.filter((p) => {
      if (p.delay > 0) {
        p.delay -= dt;
        return true;
      }
      p.t += dt;
      p.y -= p.rise * dt;
      p.x += Math.sin(p.t * 1.3 + p.phase) * p.sway * dt;
      return p.t < p.life;
    });
    inks = inks.filter((k) => (k.t += dt) < INK_SECONDS);
    flashes = flashes.filter((f) => (f.t += dt) < FLASH_SECONDS);
  }

  function drawPuff(ctx, p) {
    if (p.delay > 0) return;
    ctx.globalAlpha = Math.min(1, p.t * 4) * (1 - p.t / p.life) * (1 - p.fog * 0.7);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fillStyle = 'rgba(200, 240, 255, 0.1)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(225, 248, 255, 0.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawInk(ctx, k) {
    const u = k.t / INK_SECONDS;
    const fade = (1 - u) ** 0.8 * (1 - k.fog * 0.5);
    const grow = 0.6 + 0.6 * Math.min(1, u * 2.5);
    for (const bl of k.blobs) {
      const x = k.x + bl.ox * grow + k.vx * k.t;
      const y = k.y + bl.oy * grow + k.vy * k.t;
      const r = bl.r * grow;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(24, 8, 44, ${0.9 * fade})`);
      g.addColorStop(0.65, `rgba(24, 8, 44, ${0.6 * fade})`);
      g.addColorStop(1, 'rgba(24, 8, 44, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
  }

  // White flash with two crescents: the bite marks of the upper and lower jaws.
  function drawFlash(ctx, f) {
    ctx.globalAlpha = 1; // the bubbles before it leave their own alpha behind
    const u = f.t / FLASH_SECONDS;
    const a = 1 - u;
    const s = f.size;
    const r = s * (0.6 + 0.8 * u);
    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
    g.addColorStop(0, `rgba(255, 255, 255, ${a})`);
    g.addColorStop(0.45, `rgba(255, 255, 255, ${0.6 * a})`);
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(f.x, f.y, r, 0, TAU);
    ctx.fill();
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.scale(f.dir, 1);
    ctx.strokeStyle = `rgba(255, 255, 255, ${a})`;
    ctx.lineWidth = Math.max(2, s * 0.06);
    ctx.lineCap = 'round';
    for (const side of [-1, 1]) {
      const a0 = side < 0 ? 0.15 * Math.PI : 1.15 * Math.PI;
      ctx.beginPath();
      ctx.arc(s * 0.1, side * s * 0.12, s * 0.25 * (1 + 0.5 * u), a0, a0 + 0.7 * Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Trail and glow behind one creature (called before its body is drawn).
  function drawUnder(ctx, c) {
    const b = c.beh;
    if (!b) return;
    const fog = depth.fogAt(c.d);
    ctx.lineCap = 'round';
    for (let i = 1; i < b.trail.length; i++) {
      const p = b.trail[i - 1];
      const q = b.trail[i];
      const k = Math.min(p.life, q.life) / TRAIL_SECONDS;
      ctx.strokeStyle = `rgba(225, 250, 255, ${0.8 * k * (1 - fog)})`;
      ctx.lineWidth = q.w * k;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    if (b.act && b.act.kind === 'glow') {
      const k = bump(b.act.t / b.act.dur) * (1 - fog * 0.5);
      const r = screenW(c) * 1.1;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
      g.addColorStop(0, `rgba(120, 255, 235, ${0.55 * k})`);
      g.addColorStop(0.5, `rgba(120, 255, 235, ${0.2 * k})`);
      g.addColorStop(1, 'rgba(120, 255, 235, 0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Water effects in front of the creatures: ink clouds, bubbles and bite flashes.
  function drawFront(ctx) {
    for (const k of inks) drawInk(ctx, k);
    for (const p of puffs) drawPuff(ctx, p);
    for (const f of flashes) drawFlash(ctx, f);
    ctx.globalAlpha = 1;
  }

  // Called once per frame, after the creatures have moved. The action sets the
  // velocity here, so it wins over the normal steering for its length.
  function update(dt) {
    for (const c of creatures.values()) if (c.sprite) stepCreature(c, dt);
    stepEffects(dt);
  }

  // Test hook: starts an action on a creature by id. Returns false if it cannot.
  // Actions: dash, bubbles (any creature), and bite, ink, breathe, glow, flip
  // (only for the species that has them).
  function trigger(id, action) {
    const c = creatures.get(id);
    if (!c || c.state !== 'alive' || !c.sprite) return false;
    const b = stateOf(c);
    if (action === 'dash') {
      b.run = null;
      randomDash(c, b);
      return true;
    }
    if (action === 'bubbles' && c.species !== 'seahorse') {
      const m = at(c, 0.3, -0.3);
      chain(m.x, m.y, c.d, 7);
      return true;
    }
    // The seahorse's bubble chain comes with its spin, so 'bubbles' starts that special.
    const wanted = action === 'bubbles' ? 'spin' : action;
    if (SPECIAL[c.species] !== wanted) return false;
    b.run = null;
    if (action === 'bite') return startBite(c, b, true);
    return startSpecial(c, b);
  }

  return {
    resize(width, height) {
      W = width;
      H = height;
    },
    update,
    drawUnder,
    drawFront,
    trigger,
  };
}
