// "The Yard": an abandoned solar-array yard at desert dusk. Pure data and geometry math
// (no three.js here) so the sim, the bots and the renderer all share one map.
// Units are metres. x east [-32, 32], z south [+] / north [-], ground y = 0.
// A collider is {x0, z0, x1, z1, h, kind}: an axis-aligned box that blocks movement.
// Anything with h >= 1.15 also blocks line of sight at chest height.
//
// New in this pass: a second mid connector — the "Vent" corridor, a walled service
// passage east of the Connector that lets attackers slip from spawn to Site A without
// crossing the open mid. Plus more cover crates and containers, a third solar-panel
// row inside Site A, and pump machinery (a tank) outside Site B.
export const SITES = {
  A: { id: 'A', name: 'Array', x: 24, z: -14, r: 5 },
  B: { id: 'B', name: 'Pump', x: -24, z: -14, r: 5 },
};

export const SPAWNS = {
  attack: [{ x: -6, z: 20 }, { x: -2, z: 21 }, { x: 2, z: 21 }, { x: 6, z: 20 }],
  defend: [{ x: -6, z: -20 }, { x: -2, z: -21 }, { x: 2, z: -21 }, { x: 6, z: -20 }],
};

// The player spawns between the bot spawns, never on top of an ally.
export const PLAYER_SPAWN = {
  attack: { x: 0, z: 22 },
  defend: { x: 0, z: -22 },
};

export const LANES = {
  // East lane, A-long: spawn -> east wall -> Site A.
  A: [
    { x: 4, z: 20 }, { x: 14, z: 18 }, { x: 22, z: 14 }, { x: 26, z: 8 },
    { x: 26, z: 0 }, { x: 26, z: -6 }, { x: 24, z: -10 }, { x: 24, z: -14 },
  ],
  // West lane, B-long: spawn -> west wall -> Site B.
  B: [
    { x: -4, z: 20 }, { x: -14, z: 18 }, { x: -22, z: 14 }, { x: -26, z: 8 },
    { x: -26, z: 0 }, { x: -26, z: -6 }, { x: -24, z: -10 }, { x: -24, z: -14 },
  ],
  // Mid "Connector": straight up the middle, then branch to either site.
  mid: [
    { x: 0, z: 20 }, { x: 0, z: 12 }, { x: 0, z: 6 }, { x: 0, z: 0 },
    { x: 0, z: -6 }, { x: 0, z: -12 },
  ],
  // Second mid connector, the "Vent": a walled service corridor east of mid. It
  // enters from the spawn side at z = 14, runs north between two low walls, and
  // spills out toward Site A at z = -8. One side gap (z 2..6) lets a bot or player
  // slip back into the Connector mid-fight.
  vent: [
    { x: 10, z: 18 }, { x: 10, z: 12 }, { x: 10, z: 6 }, { x: 10, z: 0 },
    { x: 10, z: -4 }, { x: 10, z: -8 },
  ],
  ventToA: [{ x: 14, z: -12 }, { x: 19, z: -14 }, { x: 24, z: -14 }],
  midToA: [{ x: 8, z: -14 }, { x: 16, z: -14 }, { x: 24, z: -14 }],
  midToB: [{ x: -8, z: -14 }, { x: -16, z: -14 }, { x: -24, z: -14 }],
};

export const HOLDS = {
  A: [{ x: 21, z: -11 }, { x: 27, z: -16 }, { x: 24, z: -18 }],
  B: [{ x: -21, z: -11 }, { x: -27, z: -16 }, { x: -24, z: -18 }],
  mid: [{ x: 0, z: -8 }, { x: 6, z: -4 }, { x: -6, z: -4 }],
  // Second-choice holds: a defender picks the one of the pair that can actually see
  // the site it guards (checked with line of sight at round start).
  A2: [{ x: 20, z: -18 }, { x: 28, z: -10 }],
  B2: [{ x: -20, z: -18 }, { x: -28, z: -10 }],
  along: [{ x: 26, z: -2 }],
  blong: [{ x: -26, z: -2 }],
  defendSpawn: [{ x: 4, z: -19 }, { x: -4, z: -19 }],
};

// --- colliders -----------------------------------------------------------------
function box(x0, z0, x1, z1, h, kind) {
  return { x0, z0, x1, z1, h, kind };
}

export const COLLIDERS = [
  // Perimeter walls (h 4).
  box(-33, -25, 33, -24, 4, 'wall'),
  box(-33, 24, 33, 25, 4, 'wall'),
  box(-33, -24, -32, 24, 4, 'wall'),
  box(32, -24, 33, 24, 4, 'wall'),
  // Site A solar-panel rows: three rows now, each with a central gap to push through.
  box(19, -18.2, 23, -17.4, 1.8, 'panel'),
  box(25, -18.2, 29, -17.4, 1.8, 'panel'),
  box(19, -14.9, 23, -14.1, 1.8, 'panel'),
  box(25, -14.9, 29, -14.1, 1.8, 'panel'),
  box(19, -11.6, 23, -10.8, 1.8, 'panel'),
  box(25, -11.6, 29, -10.8, 1.8, 'panel'),
  // Site B pump house: solid west block, east face with a 2 m doorway (z -17..-15).
  box(-30, -20, -24, -12, 3.5, 'pumphouse'),
  box(-24, -20, -20, -17, 3.5, 'pumphouse'),
  box(-24, -15, -20, -12, 3.5, 'pumphouse'),
  // Site B pump machinery: a storage tank east of the pump house, hard cover on the
  // B approach (and a landmark for the rotate call).
  box(-20.5, -18.5, -18.5, -16.5, 2.2, 'tank'),
  // Containers (6 x 2.4, h 2.6) and tall ones (2.4 x 6).
  box(7, 8.8, 13, 11.2, 2.6, 'container'),
  box(-13, 6.8, -7, 9.2, 2.6, 'container'),
  box(14.8, -5, 17.2, 1, 2.6, 'container'),
  box(-17.2, -5, -14.8, 1, 2.6, 'container'),
  box(24.8, 3, 27.2, 9, 2.6, 'container'),
  box(-27.2, 3, -24.8, 9, 2.6, 'container'),
  box(-3, -13.2, 3, -10.8, 2.6, 'container'),
  // Two more containers guarding the Vent's mouth and the B-long elbow.
  box(13.5, 13.5, 16.5, 15.9, 2.6, 'container'),
  box(-28.5, -2.5, -26.1, 3.5, 2.6, 'container'),
  // Mid connector low wall with a 4 m gap in the middle.
  box(-8, -2.6, -2, -1.4, 1.4, 'wall'),
  box(2, -2.6, 8, -1.4, 1.4, 'wall'),
  // Vent corridor walls (h 1.4, chest-high cover): west wall in two runs with a
  // side gap at z 2..6; east wall solid. The corridor mouths stay open at z = 14
  // (spawn side) and z = -8 (Site A side).
  box(7.5, -8, 8, 2, 1.4, 'wall'),
  box(7.5, 6, 8, 14, 1.4, 'wall'),
  box(12, -8, 12.5, 14, 1.4, 'wall'),
  // Crates (1.2^3) and barrels (0.9^2, h 1.1).
  box(3.4, 15.4, 4.6, 16.6, 1.2, 'crate'),
  box(-4.6, 15.4, -3.4, 16.6, 1.2, 'crate'),
  box(5.4, -18.6, 6.6, -17.4, 1.2, 'crate'),
  box(-6.6, -18.6, -5.4, -17.4, 1.2, 'crate'),
  box(-0.6, 3.4, 0.6, 4.6, 1.2, 'crate'),
  box(-0.6, -4.6, 0.6, -3.4, 1.2, 'crate'),
  box(13.4, -8.6, 14.6, -7.4, 1.2, 'crate'),
  box(-14.6, -8.6, -13.4, -7.4, 1.2, 'crate'),
  box(19.4, -6.6, 20.6, -5.4, 1.2, 'crate'),
  box(-20.6, -6.6, -19.4, -5.4, 1.2, 'crate'),
  // Extra crates for cover variety: mid elbows and the Vent's exits.
  box(15.4, 7.4, 16.6, 8.6, 1.2, 'crate'),
  box(-16.6, 7.4, -15.4, 8.6, 1.2, 'crate'),
  box(17.4, -2.6, 18.6, -1.4, 1.2, 'crate'),
  box(-18.6, -2.6, -17.4, -1.4, 1.2, 'crate'),
  box(8.4, -9.6, 9.6, -8.4, 1.2, 'crate'),
  box(11.55, -6.45, 12.45, -5.55, 1.1, 'barrel'),
  box(-12.45, -6.45, -11.55, -5.55, 1.1, 'barrel'),
  box(21.55, 11.55, 22.45, 12.45, 1.1, 'barrel'),
  box(-22.45, 11.55, -21.55, 12.45, 1.1, 'barrel'),
  // A barrel pair flanking the Vent's mouth, so the entrance is never a free peek.
  box(6.55, 13.55, 7.45, 14.45, 1.1, 'barrel'),
  box(13.55, 13.55, 14.45, 14.45, 1.1, 'barrel'),
];

// --- geometry helpers (pure math, allocation-free where it matters) -------------

// Slab test: does the 2D segment (x0,z0)->(x1,z1) cross the AABB?
function segmentHitsBox(x0, z0, x1, z1, b) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  let tmin = 0;
  let tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (x0 < b.x0 || x0 > b.x1) return false;
  } else {
    let t1 = (b.x0 - x0) / dx;
    let t2 = (b.x1 - x0) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) {
    if (z0 < b.z0 || z0 > b.z1) return false;
  } else {
    let t1 = (b.z0 - z0) / dz;
    let t2 = (b.z1 - z0) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

// Line of sight between two points at chest height. Blocked by any collider h >= 1.15,
// and by smoke clouds (segment passing within smokeRadius of a cloud centre).
export function losClear(x0, z0, x1, z1, smokes) {
  for (let i = 0; i < COLLIDERS.length; i += 1) {
    const c = COLLIDERS[i];
    if (c.h < 1.15) continue;
    if (segmentHitsBox(x0, z0, x1, z1, c)) return false;
  }
  if (smokes) {
    for (let i = 0; i < smokes.length; i += 1) {
      const s = smokes[i];
      if (s.t <= 0) continue;
      if (segmentPointDist(x0, z0, x1, z1, s.x, s.z) < s.r) return false;
    }
  }
  return true;
}

export function segmentPointDist(x0, z0, x1, z1, px, pz) {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  let t = len2 === 0 ? 0 : ((px - x0) * dx + (pz - z0) * dz) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = x0 + dx * t;
  const cz = z0 + dz * t;
  return Math.hypot(px - cx, pz - cz);
}

// Move a circle (radius r) by (dx, dz) with AABB collision and sliding: resolve x,
// then z, so the circle slides along walls instead of sticking.
export function moveCircle(pos, r, dx, dz) {
  let nx = pos.x + dx;
  let nz = pos.z + dz;
  for (let i = 0; i < COLLIDERS.length; i += 1) {
    const c = COLLIDERS[i];
    if (nx + r > c.x0 && nx - r < c.x1 && pos.z + r > c.z0 && pos.z - r < c.z1) {
      if (dx > 0) nx = c.x0 - r;
      else if (dx < 0) nx = c.x1 + r;
    }
  }
  for (let i = 0; i < COLLIDERS.length; i += 1) {
    const c = COLLIDERS[i];
    if (nx + r > c.x0 && nx - r < c.x1 && nz + r > c.z0 && nz - r < c.z1) {
      if (dz > 0) nz = c.z0 - r;
      else if (dz < 0) nz = c.z1 + r;
    }
  }
  // Clamp inside the yard.
  if (nx < -31.5) nx = -31.5;
  if (nx > 31.5) nx = 31.5;
  if (nz < -23.5) nz = -23.5;
  if (nz > 23.5) nz = 23.5;
  pos.x = nx;
  pos.z = nz;
}

export function insideSite(x, z, site) {
  const dx = x - site.x;
  const dz = z - site.z;
  return dx * dx + dz * dz <= site.r * site.r;
}

export function nearestSite(x, z) {
  const da = Math.hypot(x - SITES.A.x, z - SITES.A.z);
  const db = Math.hypot(x - SITES.B.x, z - SITES.B.z);
  return da <= db ? SITES.A : SITES.B;
}
