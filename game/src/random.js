// Seeded RNG toolkit for DUSTLINE.
//
// One rule governs this module: the simulation's determinism lives and dies by
// `mulberry32`. The screenshot states (?shot=) and the bot behaviour are replayed
// from a single seed, and the sim never calls Math.random — so `mulberry32` below
// is byte-for-byte the original implementation and must never be "improved".
// Everything else in this file is a small, pure helper built on top of a caller
// supplied rng function: shuffle a list, pick by weight, or draw a bell curve.
// Audio owns its own throwaway rng (seeded from the clock) for ambient variation;
// that is sound only and never feeds the sim.
//
// Conventions:
// - Every helper takes the rng as its first argument, so a caller can pass the
//   sim rng (deterministic) or a private one (ambient, non-deterministic).
// - Helpers never mutate their inputs unless the name says so: shuffle() returns
//   a new array, weightedPick() only reads its table.

export function mulberry32(initial) {
  let a = initial | 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform float in [min, max).
export function range(rng, min, max) {
  return min + rng() * (max - min);
}

// Uniform pick from a non-empty list.
export function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

// True with probability p (0..1).
export function chance(rng, p) {
  return rng() < p;
}

// Fisher-Yates shuffle. Returns a NEW array; the input order is untouched, so
// a caller can reshuffle the same source list every round without destroying it.
export function shuffle(rng, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// Weighted pick. Each entry is either a [value, weight] pair or an object with
// { value, weight } — both shapes are accepted so call sites can use whichever
// reads better. Weights must be non-negative and at least one must be positive;
// zero-weight entries are never picked. Returns the entry's value, not the
// entry itself, so the table stays declarative at the call site.
//
//   weightedPick(rng, [['sand', 6], ['gravel', 3], ['metal', 1]]) // => 'sand'
//   weightedPick(rng, [{ value: 'gust', weight: 3 }, { value: 'calm', weight: 5 }])
export function weightedPick(rng, entries) {
  let total = 0;
  for (const entry of entries) {
    const weight = Array.isArray(entry) ? entry[1] : entry.weight;
    if (weight < 0) throw new Error('weightedPick: negative weight');
    total += weight;
  }
  if (!(total > 0)) throw new Error('weightedPick: total weight must be positive');
  let roll = rng() * total;
  for (const entry of entries) {
    const value = Array.isArray(entry) ? entry[0] : entry.value;
    const weight = Array.isArray(entry) ? entry[1] : entry.weight;
    roll -= weight;
    if (roll < 0) return value;
  }
  // Floating-point rounding can leave roll a hair above zero after the last
  // entry; fall back to the final value instead of returning undefined.
  const last = entries[entries.length - 1];
  return Array.isArray(last) ? last[0] : last.value;
}

// Approximately normal (bell-curve) draw with the given mean and standard
// deviation, via the Box-Muller transform. Two rng() calls per draw. The
// `1 - rng()` keeps u1 away from 0 so Math.log never sees -Infinity.
// Useful for human-ish variation: bot reaction times, spread jitter, gust
// strength — anywhere a uniform draw would feel too mechanical.
export function gaussian(rng, mean = 0, stddev = 1) {
  const u1 = 1 - rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}
