// Weapon runtime state. A weapon is plain data: {def, mag, reserve, reloading,
// reloadEndsAt, lastShotAt}. The sim owns the clock (seconds); render only reads mag.
// New in this pass: reloadProgress() so the HUD can draw a reload bar, and the
// falloff curve is its own function so the sim and the bots share one damage model.
import { WEAPONS } from './config.js';

export function createWeapon(defId) {
  const def = WEAPONS[defId];
  return {
    def, mag: def.mag, reserve: def.reserve,
    reloading: false, reloadEndsAt: 0, lastShotAt: -10,
  };
}

// Can the trigger be pulled right now? (rate limit + not reloading + ammo)
export function canFire(w, now) {
  if (w.reloading) return false;
  if (w.mag <= 0) return false;
  return now - w.lastShotAt >= w.def.rateMs / 1000;
}

export function fire(w, now) {
  if (!canFire(w, now)) return false;
  w.lastShotAt = now;
  w.mag -= 1;
  return true;
}

export function startReload(w, now) {
  if (w.reloading || w.mag >= w.def.mag || w.reserve <= 0) return false;
  w.reloading = true;
  w.reloadEndsAt = now + w.def.reloadMs / 1000;
  return true;
}

// Called every fixed step: completes a reload whose timer expired.
export function updateWeapon(w, now) {
  if (w.reloading && now >= w.reloadEndsAt) {
    const need = w.def.mag - w.mag;
    const take = Math.min(need, w.reserve);
    w.mag += take;
    w.reserve -= take;
    w.reloading = false;
  }
}

// Fraction of the current reload that has elapsed (0 when not reloading). The HUD
// draws this as a thin bar under the weapon name.
export function reloadProgress(w, now) {
  if (!w.reloading) return 0;
  const total = w.def.reloadMs / 1000;
  const left = w.reloadEndsAt - now;
  return Math.min(1, Math.max(0, 1 - left / total));
}

// Current spread (radians) for a shot: base, plus movement penalty, minus crouch bonus.
export function currentSpread(w, moving, crouching) {
  let s = w.def.spread + (moving ? w.def.spreadMove : 0);
  if (crouching) s *= 0.6;
  return s;
}

// Damage multiplier at a distance: full out to 25 m, then a per-weapon falloff that
// bottoms out at 40% so long shots still sting.
export function falloffAt(def, dist) {
  if (dist <= 25) return 1;
  return Math.max(0.4, 1 - (dist - 25) * def.falloff / 40);
}

// Damage at a distance, with falloff past 25 m.
export function damageAt(def, dist, head) {
  return def.dmg * falloffAt(def, dist) * (head ? def.headMult : 1);
}

// One-line summary for the HUD and the killfeed ("VK-7 Rifle — 18 / 75").
export function weaponSummary(w) {
  return `${w.def.name} — ${w.mag} / ${w.reserve}`;
}
