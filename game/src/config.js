// DUSTLINE configuration, rebuilt for the threejs-fps-02 pivot: every tuning number
// lives here so the sim, the HUD and the buy menu all read the same values. No other
// module hard-codes a price, a damage or a timer. New in this pass: the Longshot DMR
// (a semi-auto precision rifle between the VK-7 and the Longbow), bot grenade tuning,
// and a small spread rebalance so holding still is rewarded a little more.
export const CFG = {
  mapW: 64, // x in [-32, 32]
  mapD: 48, // z in [-24, 24]
  roundTime: 100, // seconds of live play per round
  buyTime: 15, // seconds of buy phase before each round
  plantTime: 4, // seconds to plant the spike (hold E)
  defuseTime: 5, // seconds to defuse the spike (hold E)
  spikeTime: 35, // seconds from plant to detonation
  winScore: 5, // first to 5 round wins takes the match (max 9 rounds)
  maxRounds: 9,
  startMoney: 800,
  winBonus: 300,
  lossBonus: 150,
  killBonus: 100,
  plantBonus: 200,
  defuseBonus: 200,
  eyeStand: 1.62,
  eyeCrouch: 1.05,
  playerRadius: 0.42,
  playerHp: 100,
  botHp: 100,
  walkSpeed: 5.2,
  accel: 42,
  friction: 9,
  botSpeed: 3.6,
  botRotateSpeed: 4.5, // bots hurry to a planted spike faster than they patrol
  botReactMin: 0.45, // bot reaction time range (seconds)
  botReactMax: 0.9,
  hearRadius: 30, // gunshots are heard this far
  fragFuse: 1.2,
  fragRadius: 6,
  smokeTime: 12,
  smokeRadius: 3.5,
  // Bot grenades: attackers carry one frag from round 2 on. A bot only lobs it at a
  // position it recently saw or heard, never through a wall it cannot place, and the
  // throw is telegraphed by a wind-up pause plus a killfeed line.
  botFragRounds: 2, // earliest round a bot may carry a frag
  botFragChance: 0.7, // chance an attacking bot spawns with one
  botFragRange: 14, // a bot only throws at a known position inside this distance
  botFragCooldown: 9, // seconds between one bot's throws
  botFragWindup: 0.6, // seconds the bot stands still before the throw lands
  // Peeking: a holding bot leans out toward a position it recently saw, fires if it
  // gets line of sight, then pulls back to its hold.
  peekHoldMin: 0.9, // seconds out of cover
  peekHoldMax: 1.6,
  peekCooldown: 4, // seconds between peeks for one bot
  peekMemory: 4, // seconds a last-seen position stays worth peeking at
  // Retreat: a badly hurt bot that is outnumbered gives ground instead of dying in
  // the open.
  retreatHp: 35,
  retreatTime: 2, // seconds of falling back before the bot re-engages
  retreatDist: 6, // metres it tries to put between itself and the threat
};

// Weapon table. dmg is chest damage at close range; headMult multiplies on headshots.
// spread is radians of cone half-angle while standing still; spreadMove is added while
// moving. The rebalance trims base spread on the automatics a touch and makes the DMR
// the accurate mid-range answer: tighter than the VK-7, slower than the Raptor.
export const WEAPONS = {
  p9: {
    id: 'p9', name: 'P9 Pistol', price: 0, dmg: 26, headMult: 2.5, rateMs: 300,
    mag: 12, reserve: 36, reloadMs: 1400, spread: 0.007, spreadMove: 0.02,
    auto: false, pellets: 1, speed: 1.0, kick: 0.011, falloff: 0.35,
  },
  vk7: {
    id: 'vk7', name: 'VK-7 Rifle', price: 400, dmg: 30, headMult: 2.5, rateMs: 110,
    mag: 25, reserve: 75, reloadMs: 2200, spread: 0.011, spreadMove: 0.03,
    auto: true, pellets: 1, speed: 0.94, kick: 0.014, falloff: 0.3,
  },
  raptor: {
    id: 'raptor', name: 'Raptor SMG', price: 250, dmg: 20, headMult: 2.5, rateMs: 90,
    mag: 32, reserve: 96, reloadMs: 1800, spread: 0.015, spreadMove: 0.028,
    auto: true, pellets: 1, speed: 0.97, kick: 0.009, falloff: 0.45,
  },
  longbow: {
    id: 'longbow', name: 'Longbow Sniper', price: 700, dmg: 95, headMult: 2.5, rateMs: 1200,
    mag: 5, reserve: 15, reloadMs: 3000, spread: 0.002, spreadMove: 0.05,
    auto: false, pellets: 1, speed: 0.9, kick: 0.05, falloff: 0.1,
  },
  longshot: {
    id: 'longshot', name: 'Longshot DMR', price: 550, dmg: 55, headMult: 2.5, rateMs: 420,
    mag: 10, reserve: 30, reloadMs: 2400, spread: 0.004, spreadMove: 0.04,
    auto: false, pellets: 1, speed: 0.92, kick: 0.03, falloff: 0.15,
  },
  breacher: {
    id: 'breacher', name: 'Breacher Shotgun', price: 350, dmg: 12, headMult: 2.0, rateMs: 800,
    mag: 6, reserve: 18, reloadMs: 2600, spread: 0.048, spreadMove: 0.03,
    auto: false, pellets: 8, speed: 0.93, kick: 0.03, falloff: 0.6,
  },
};

export const GRENADE_PRICES = { frag: 150, smoke: 100 };
export const ARMOR_PRICE = 300; // absorbs 50% of incoming damage
export const ARMOR_ABSORB = 0.5;

export const TEAMS = {
  vanguard: { id: 'vanguard', name: 'Vanguard', color: 0x2fd4c4, css: '#2fd4c4' },
  jackals: { id: 'jackals', name: 'Jackals', color: 0xe86a2c, css: '#e86a2c' },
};

// Bot loadout by round: early rounds are pistol/SMG rounds, rifles arrive later,
// and from round 5 a few bots carry the Longshot DMR for mid-range lanes.
export function botLoadout(rng, round) {
  if (round <= 1) return 'p9';
  if (round === 2) return 'raptor';
  if (round <= 4) return rng() < 0.6 ? 'vk7' : 'raptor';
  const roll = rng();
  if (roll < 0.55) return 'vk7';
  if (roll < 0.8) return 'longbow';
  return 'longshot';
}
