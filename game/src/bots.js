// Bot AI, rebuilt for the threejs-fps-02 pivot: 3 allies + 4 enemies. States: route
// (follow a lane), hold (watch an angle), peek (lean out from cover at a last-seen
// position, fire, pull back), engage (seen an enemy: react, then burst fire with
// pauses and strafing), retreat (hurt and outnumbered: give ground), plant / defuse
// (channel the objective), rotate (move to a noise or a planted spike).
// Perception is analytic: segment-vs-AABB line of sight (see map.js) and a hearing
// radius for gunshots. Bots never raycast; shooting is a probability model on distance,
// target movement and stance, so a bot fight reads like a real one without per-frame
// cost. Bots also carry one frag from round 2: when an enemy is known but out of sight
// they wind up (0.6 s, standing still) and lob it — the throw is telegraphed in the
// killfeed so the player can move.
import { CFG, botLoadout } from './config.js';
import { LANES, HOLDS, SPAWNS, SITES, STAGING, SITE_ENTRANCE, moveCircle, losClear, insideSite } from './map.js';
import { createWeapon, damageAt } from './weapons.js';
import { range, pick, chance } from './random.js';

const ALLY_NAMES = ['Rook', 'Iris', 'Fenn'];
const ENEMY_NAMES = ['Vex', 'Onyx', 'Mara', 'Kestrel'];

// Pick a hold spot that can actually see the site it guards: try the primary spot,
// fall back to the second-choice spot when a wall blocks the first.
function pickHoldSpot(candidates, site, smokes) {
  for (const spot of candidates) {
    if (losClear(spot.x, spot.z, site.x, site.z, smokes)) return spot;
  }
  return candidates[0];
}

export function createBots(rng, round, playerTeam) {
  const bots = [];
  const lanes = ['A', 'B', 'mid', 'vent'];
  for (let i = 0; i < 7; i += 1) {
    const isAlly = i < 3;
    const team = isAlly ? playerTeam : (playerTeam === 'vanguard' ? 'jackals' : 'vanguard');
    // Vanguard attacks on odd rounds, Jackals on even ones.
    const attacking = team === 'vanguard' ? (round % 2 === 1) : (round % 2 === 0);
    const spawn = isAlly
      ? SPAWNS[attacking ? 'attack' : 'defend'][i]
      : SPAWNS[attacking ? 'attack' : 'defend'][i - 3];
    const bot = {
      id: i,
      name: isAlly ? ALLY_NAMES[i] : ENEMY_NAMES[i - 3],
      team, isAlly, attacking,
      alive: true, hp: CFG.botHp, armor: round >= 3,
      x: spawn.x, z: spawn.z, yaw: attacking ? Math.PI : 0, // attackers face north (-z)
      vx: 0, vz: 0,
      state: 'route', lane: null, waypoints: [], wpIndex: 0,
      holdPos: null, holdBaseYaw: 0, holdUntil: 0,
      weapon: createWeapon(botLoadout(rng, round)),
      target: null, reactEndsAt: 0,
      burstLeft: 0, burstPauseUntil: 0, nextShotAt: 0,
      strafeDir: 1, strafeUntil: 0,
      channel: 0, channelKind: null,
      noiseX: 0, noiseZ: 0, noiseUntil: 0,
      interrupted: false, lastHurtAt: -10,
      site: null,
      // Peeking: where an enemy was last seen, and when the bot may lean out again.
      lastSeenX: 0, lastSeenZ: 0, lastSeenAt: -100,
      peekUntil: 0, peekCooldownUntil: 0, peekFrom: null,
      // Retreat: where the bot falls back to when hurt and outnumbered.
      retreatUntil: 0,
      // Grenades: attackers may carry one frag from round 2 on.
      frags: attacking && round >= CFG.botFragRounds && chance(rng, CFG.botFragChance) ? 1 : 0,
      fragCooldownUntil: 0, windupUntil: 0, windupTarget: null,
      // Smokes: defenders may carry one smoke from round 3 on, spent on the retake.
      smokes: !attacking && round >= CFG.botSmokeRounds && chance(rng, CFG.botSmokeChance) ? 1 : 0,
      // Regroup: rally at the site staging point before pushing in together.
      regroupUntil: 0, regrouped: false, rallyTarget: null,
    };
    if (attacking) {
      bot.lane = lanes[i % 4];
      bot.site = bot.lane === 'mid' || bot.lane === 'vent'
        ? (chance(rng, 0.5) ? SITES.A : SITES.B)
        : SITES[bot.lane];
      bot.waypoints = routeToSite(bot.lane, bot.site);
    } else {
      // Defenders: one holds each site, one watches mid, one roams the longs. Each
      // hold spot is picked so it can actually see the site it guards.
      const siteFor = i % 4 === 0 ? SITES.A : i % 4 === 1 ? SITES.B : null;
      const spots = i % 4 === 0
        ? [HOLDS.A[0], ...HOLDS.A2]
        : i % 4 === 1
          ? [HOLDS.B[0], ...HOLDS.B2]
          : i % 4 === 2 ? [HOLDS.mid[0]] : [HOLDS.along[0]];
      bot.holdPos = siteFor ? pickHoldSpot(spots, siteFor, null) : spots[0];
      bot.waypoints = [{ x: bot.holdPos.x, z: bot.holdPos.z }];
      bot.holdBaseYaw = bot.holdPos.x > 0 ? -Math.PI / 2 : Math.PI / 2;
      if (bot.holdPos.z < -6) bot.holdBaseYaw = Math.PI; // mid holder faces the attackers
    }
    bots.push(bot);
  }
  return bots;
}

function routeToSite(lane, site) {
  if (lane === 'vent') {
    return LANES.vent.concat(LANES.ventToA).map((p) => ({ x: p.x, z: p.z }));
  }
  const base = lane === 'mid'
    ? LANES.mid.concat(site.id === 'A' ? LANES.midToA : LANES.midToB)
    : LANES[lane];
  return base.map((p) => ({ x: p.x, z: p.z }));
}

function routeToPoint(bot, x, z) {
  // Go via mid first when far south of the objective, else straight there.
  const wps = [];
  if (bot.z > -2 && z < -8) wps.push({ x: 0, z: -6 });
  wps.push({ x, z });
  return wps;
}

// Nearest visible enemy for a bot: the player, or an opposing bot. Returns
// {kind:'player'|'bot', ref, dist} or null.
function nearestVisible(bot, ctx) {
  let best = null;
  const consider = (kind, ref, x, z, alive) => {
    if (!alive) return;
    const dx = x - bot.x;
    const dz = z - bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 45) return;
    if (!losClear(bot.x, bot.z, x, z, ctx.smokes)) return;
    if (!best || dist < best.dist) best = { kind, ref, dist };
  };
  consider('player', ctx.player, ctx.player.x, ctx.player.z, ctx.player.alive);
  for (const other of ctx.bots) {
    if (other === bot || !other.alive || other.team === bot.team) continue;
    consider('bot', other, other.x, other.z, true);
  }
  return best;
}

function moveToward(bot, tx, tz, dt, speed) {
  const dx = tx - bot.x;
  const dz = tz - bot.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return 0;
  const step = Math.min(dist, speed * dt);
  const mx = (dx / dist) * step;
  const mz = (dz / dist) * step;
  const px = bot.x;
  const pz = bot.z;
  moveCircle(bot, CFG.playerRadius, mx, mz);
  bot.vx = (bot.x - px) / dt;
  bot.vz = (bot.z - pz) / dt;
  bot.yaw = Math.atan2(mx, mz);
  return dist - step;
}

// How many fighters on each side are still standing? A bot that is outnumbered
// while hurt would rather give ground than die in the open.
function teamCounts(ctx) {
  let allies = 0;
  let enemies = 0;
  for (const b of ctx.bots) {
    if (!b.alive) continue;
    if (b.team === 'vanguard') allies += 1;
    else enemies += 1;
  }
  if (ctx.player.alive) allies += 1; // the player fights for Vanguard
  return { allies, enemies };
}

// Living bots on one team (the player is not a bot; callers add them if needed).
function aliveOnTeam(ctx, team) {
  let n = 0;
  for (const b of ctx.bots) if (b.alive && b.team === team) n += 1;
  return n;
}

// Bot accuracy: falls with distance, and the target being harder to hit helps.
function hitChance(rng, bot, target, dist) {
  const moving = target.kind === 'player'
    ? target.ref.moving
    : Math.hypot(target.ref.vx, target.ref.vz) > 0.5;
  const crouch = target.kind === 'player' ? target.ref.crouching : false;
  let p = 0.62 - dist * 0.011 - (moving ? 0.12 : 0) - (crouch ? 0.08 : 0);
  if (bot.weapon.def.id === 'longbow') p += 0.08;
  if (bot.weapon.def.id === 'longshot') p += 0.05;
  if (p < 0.06) p = 0.06;
  if (p > 0.6) p = 0.6;
  return p;
}

// Strafe sideways across the sightline; when hurt, the strafe flips so the bot
// drifts backwards instead of sideways, giving ground while it shoots.
function strafeStep(bot, ctx, dt) {
  const now = ctx.now;
  if (now > bot.strafeUntil) {
    bot.strafeDir = ctx.rng() < 0.5 ? -1 : 1;
    bot.strafeUntil = now + range(ctx.rng, 0.8, 1.6);
  }
  const backing = bot.hp < 35 && now - bot.lastHurtAt < 2;
  const dir = bot.strafeDir * (backing ? -1 : 1);
  const sx = Math.cos(bot.yaw) * dir;
  const sz = -Math.sin(bot.yaw) * dir;
  const step = CFG.botSpeed * 0.55;
  moveCircle(bot, CFG.playerRadius, sx * step * dt, sz * step * dt);
  // Expose the strafe velocity so the renderer can swing the legs.
  bot.vx = sx * step;
  bot.vz = sz * step;
}

// One burst of fire at the visible target: bursts of 3-5 shots with pauses between,
// each shot a hit-chance roll on distance, target movement and stance.
function fireBurst(bot, seen, ctx, actions) {
  const now = ctx.now;
  if (now < bot.reactEndsAt) return;
  if (bot.burstLeft <= 0) {
    if (now >= bot.burstPauseUntil) bot.burstLeft = 3 + Math.floor(ctx.rng() * 3);
    return;
  }
  if (now < bot.nextShotAt) return;
  const t = seen.ref;
  const dist = seen.dist;
  const hit = ctx.rng() < hitChance(ctx.rng, bot, seen, dist);
  const head = hit && ctx.rng() < 0.08;
  const dmg = hit ? damageAt(bot.weapon.def, dist, head) : 0;
  // Misses land near the target so tracers still read.
  const miss = hit ? 0 : range(ctx.rng, 0.3, 0.9);
  actions.push({
    type: 'shot', bot, target: seen, hit, head, dmg,
    missX: t.x + (ctx.rng() - 0.5) * miss * 2,
    missZ: t.z + (ctx.rng() - 0.5) * miss * 2,
  });
  bot.burstLeft -= 1;
  bot.nextShotAt = now + bot.weapon.def.rateMs / 1000 + ctx.rng() * 0.05;
  if (bot.burstLeft <= 0) bot.burstPauseUntil = now + range(ctx.rng, 0.6, 1.2);
}

// Engaged: face the target, retreat when hurt and outnumbered, strafe and burst
// fire otherwise. Losing sight drops the bot back to route (attackers) or hold.
function stepEngage(bot, seen, ctx, dt, actions) {
  const now = ctx.now;
  if (!seen || !bot.target) {
    bot.target = null;
    bot.state = bot.attacking ? 'route' : 'hold';
    bot.channel = 0;
    bot.channelKind = null;
    return;
  }
  bot.target = seen;
  const t = seen.ref;
  bot.yaw = Math.atan2(t.x - bot.x, t.z - bot.z);
  // Hurt and outnumbered: fall back instead of trading in the open.
  const counts = teamCounts(ctx);
  const mine = bot.team === 'vanguard' ? counts.allies : counts.enemies;
  const theirs = bot.team === 'vanguard' ? counts.enemies : counts.allies;
  if (bot.hp < CFG.retreatHp && now - bot.lastHurtAt < 2 && theirs > mine) {
    bot.state = 'retreat';
    bot.retreatUntil = now + CFG.retreatTime;
    // Fall back away from the threat, toward the bot's own half of the yard.
    const dx = bot.x - t.x;
    const dz = bot.z - t.z;
    const d = Math.hypot(dx, dz) || 1;
    bot.waypoints = [{ x: bot.x + (dx / d) * CFG.retreatDist, z: bot.z + (dz / d) * CFG.retreatDist }];
    bot.wpIndex = 0;
    return;
  }
  strafeStep(bot, ctx, dt);
  fireBurst(bot, seen, ctx, actions);
}

export function stepBots(bots, ctx, dt) {
  const actions = [];
  for (const bot of bots) {
    if (!bot.alive) continue;
    const now = ctx.now;

    // Hearing: a recent gunshot nearby pulls a routing/holding bot to investigate.
    if (ctx.noise && now < ctx.noise.until && bot.state !== 'engage' && bot.state !== 'plant' && bot.state !== 'defuse') {
      const d = Math.hypot(ctx.noise.x - bot.x, ctx.noise.z - bot.z);
      if (d < CFG.hearRadius) {
        bot.noiseX = ctx.noise.x;
        bot.noiseZ = ctx.noise.z;
        bot.noiseUntil = now + 3;
      }
    }

    // Perception: scan for a visible enemy every step (cheap analytic LOS).
    const seen = nearestVisible(bot, ctx);
    if (seen) {
      // Remember where enemies were last seen: peeking and grenades work off it.
      const t = seen.ref;
      bot.lastSeenX = seen.kind === 'player' ? t.x : t.x;
      bot.lastSeenZ = seen.kind === 'player' ? t.z : t.z;
      bot.lastSeenAt = now;
    }
    if (seen && bot.state !== 'engage') {
      bot.state = 'engage';
      bot.target = seen;
      bot.reactEndsAt = now + range(ctx.rng, CFG.botReactMin, CFG.botReactMax);
      bot.burstLeft = 0;
      bot.burstPauseUntil = 0;
    }

    // Grenade wind-up finishing: the throw finally leaves the hand.
    if (bot.windupUntil > 0 && now >= bot.windupUntil) {
      const target = bot.windupTarget;
      bot.windupUntil = 0;
      bot.windupTarget = null;
      if (target && bot.frags > 0) {
        bot.frags -= 1;
        bot.fragCooldownUntil = now + CFG.botFragCooldown;
        actions.push({ type: 'throw', bot, kind: 'frag', tx: target.x, tz: target.z });
      }
      continue;
    }

    if (bot.state === 'engage') {
      stepEngage(bot, seen, ctx, dt, actions);
      continue;
    }

    // Objective: attackers plant when their site is clear; defenders defuse when safe.
    // A planted spike sends defenders to it — but not one by one. With a living
    // teammate, a defender rallies at the site staging point first and pushes in
    // together (see the 'regroup' handler); a lone defender goes straight in.
    if (ctx.spike.planted && !bot.attacking) {
      const spike = ctx.spike;
      const d = Math.hypot(spike.x - bot.x, spike.z - bot.z);
      if (d < 2.2 && !nearestVisible(bot, ctx)) {
        bot.state = 'defuse';
        bot.channelKind = 'defuse';
      } else if (bot.state !== 'regroup' && (bot.state !== 'rotate' || bot.wpIndex >= bot.waypoints.length)) {
        // A living teammate (a bot, or the player when the bot fights for
        // Vanguard) is what makes a rally worth waiting for.
        const teammates = aliveOnTeam(ctx, bot.team)
          + (bot.team === 'vanguard' && ctx.player.alive ? 1 : 0);
        if (!bot.regrouped && teammates >= 2) {
          const staging = STAGING[spike.site.id];
          if (Math.hypot(staging.x - bot.x, staging.z - bot.z) > 3) {
            bot.state = 'rotate';
            bot.waypoints = [{ x: staging.x, z: staging.z }];
            bot.wpIndex = 0;
            bot.rallyTarget = spike.site.id;
          } else {
            bot.state = 'regroup';
            bot.regroupUntil = now + CFG.regroupWait;
          }
        } else {
          bot.state = 'rotate';
          bot.waypoints = routeToPoint(bot, spike.x, spike.z);
          bot.wpIndex = 0;
        }
      }
    }
    if (bot.state === 'defuse') {
      const spike = ctx.spike;
      const near = Math.hypot(spike.x - bot.x, spike.z - bot.z) < 2.2;
      if (!near || nearestVisible(bot, ctx) || bot.interrupted) {
        bot.channel = 0;
        bot.channelKind = null;
        bot.state = 'rotate';
        bot.interrupted = false;
        continue;
      }
      bot.channel += dt;
      if (bot.channel >= CFG.defuseTime) {
        actions.push({ type: 'defuse-done', bot });
        bot.channel = 0;
        bot.channelKind = null;
        bot.state = 'hold';
      }
      continue;
    }
    if (bot.state === 'plant') {
      const site = bot.site;
      const clear = !nearestVisible(bot, ctx);
      if (!clear || bot.interrupted || !insideSite(bot.x, bot.z, site)) {
        bot.channel = 0;
        bot.channelKind = null;
        bot.state = 'route';
        bot.interrupted = false;
        continue;
      }
      bot.channel += dt;
      if (bot.channel >= CFG.plantTime) {
        actions.push({ type: 'plant-done', bot, site });
        bot.channel = 0;
        bot.channelKind = null;
        bot.state = 'hold';
        bot.holdPos = { x: bot.x, z: bot.z };
      }
      continue;
    }

    // Regroup: wait at the staging point until a teammate is close, or the wait
    // runs out — then push to the spike together. If the spike is gone (defused
    // or detonated) the rally is off and the bot goes back to holding.
    if (bot.state === 'regroup') {
      if (!ctx.spike.planted) {
        bot.state = 'hold';
        bot.regrouped = false;
        bot.rallyTarget = null;
        continue;
      }
      const staging = STAGING[ctx.spike.site.id];
      const teammateNear = ctx.bots.some((o) => o !== bot && o.alive && o.team === bot.team
        && Math.hypot(o.x - staging.x, o.z - staging.z) < CFG.regroupRadius);
      if (teammateNear || now >= bot.regroupUntil) {
        bot.regrouped = true;
        bot.rallyTarget = null;
        bot.state = 'rotate';
        bot.waypoints = routeToPoint(bot, ctx.spike.x, ctx.spike.z);
        bot.wpIndex = 0;
      }
      continue;
    }

    // Retreat: fall back for a couple of seconds, then re-engage from cover.
    if (bot.state === 'retreat') {
      const wp = bot.waypoints[bot.wpIndex];
      if (!wp || now >= bot.retreatUntil) {
        bot.state = bot.attacking ? 'route' : 'hold';
        bot.waypoints = bot.attacking ? routeToSite(bot.lane, bot.site) : [{ x: bot.holdPos.x, z: bot.holdPos.z }];
        bot.wpIndex = 0;
        continue;
      }
      const left = moveToward(bot, wp.x, wp.z, dt, CFG.botSpeed * 1.1);
      if (left <= 0.6) bot.wpIndex += 1;
      continue;
    }

    // Peek: a holding bot leans out toward a position it recently saw, then pulls
    // back to its hold. Only when the memory is fresh and the cooldown has passed.
    if (bot.state === 'peek') {
      const wp = bot.waypoints[bot.wpIndex];
      const out = bot.wpIndex === 0;
      if (!wp || now >= bot.peekUntil) {
        if (out) {
          bot.waypoints = [bot.peekFrom];
          bot.wpIndex = 0;
        } else {
          bot.state = 'hold';
          bot.peekCooldownUntil = now + CFG.peekCooldown;
          continue;
        }
      }
      const left = moveToward(bot, wp.x, wp.z, dt, CFG.botSpeed);
      if (left <= 0.6) bot.wpIndex += 1;
      continue;
    }

    // Route / hold / rotate movement.
    if (bot.state === 'route' || bot.state === 'rotate') {
      const wp = bot.waypoints[bot.wpIndex];
      if (!wp) {
        // Arrived at the rally point: wait for a teammate, then push together.
        if (bot.rallyTarget && !bot.regrouped && ctx.spike.planted && !bot.attacking) {
          bot.rallyTarget = null;
          bot.state = 'regroup';
          bot.regroupUntil = now + CFG.regroupWait;
          continue;
        }
        if (bot.attacking && bot.site && insideSite(bot.x, bot.z, bot.site)) {
          // Reached the site: plant if it is clear, else hold the edge.
          if (!nearestVisible(bot, ctx) && !ctx.spike.planted) {
            bot.state = 'plant';
            bot.channel = 0;
            bot.channelKind = 'plant';
          } else {
            bot.state = 'hold';
            bot.holdPos = { x: bot.x, z: bot.z };
          }
        } else {
          bot.state = 'hold';
          bot.holdPos = bot.holdPos || { x: bot.x, z: bot.z };
        }
        continue;
      }
      // Retake smoke: a defending bot with a smoke spends it at the site
      // entrance while pushing in, so the planter's sightline is blocked.
      // One cloud per entrance — a second bot holds its smoke if the entrance
      // is already covered.
      if (bot.state === 'rotate' && ctx.spike.planted && !bot.attacking && bot.smokes > 0) {
        const site = ctx.spike.site;
        if (Math.hypot(site.x - bot.x, site.z - bot.z) < CFG.botSmokeRange) {
          const entrance = SITE_ENTRANCE[site.id];
          const covered = ctx.smokes.some((s) => Math.hypot(s.x - entrance.x, s.z - entrance.z) < 4);
          if (!covered) {
            bot.smokes -= 1;
            actions.push({ type: 'throw', bot, kind: 'smoke', tx: entrance.x, tz: entrance.z });
          }
        }
      }
      // Rotating to a planted spike is urgent: move faster than patrol speed.
      const speed = bot.state === 'rotate' && ctx.spike.planted ? CFG.botRotateSpeed : CFG.botSpeed;
      const left = moveToward(bot, wp.x, wp.z, dt, speed);
      if (left <= 0.6) bot.wpIndex += 1;
      // A heard noise diverts a routing bot briefly.
      if (now < bot.noiseUntil && bot.state === 'route') {
        const nd = Math.hypot(bot.noiseX - bot.x, bot.noiseZ - bot.z);
        if (nd > 4) {
          bot.state = 'rotate';
          bot.waypoints = [{ x: bot.noiseX, z: bot.noiseZ }];
          bot.wpIndex = 0;
          bot.noiseUntil = 0;
        }
      }
      continue;
    }

    // Hold: stand, sweep the angle slowly.
    if (bot.state === 'hold') {
      bot.vx = 0;
      bot.vz = 0;
      bot.yaw = bot.holdBaseYaw + Math.sin(now * 0.45 + bot.id * 1.7) * 0.55;
      // A bot with a frag lobs it at a last-seen position it cannot see directly:
      // the wind-up telegraphs the throw (killfeed line, then the grenade arcs in).
      if (
        bot.frags > 0 && now >= bot.fragCooldownUntil && bot.windupUntil <= 0
        && now - bot.lastSeenAt < CFG.peekMemory
      ) {
        const d = Math.hypot(bot.lastSeenX - bot.x, bot.lastSeenZ - bot.z);
        if (d > 3 && d < CFG.botFragRange && !losClear(bot.x, bot.z, bot.lastSeenX, bot.lastSeenZ, ctx.smokes)) {
          bot.windupUntil = now + CFG.botFragWindup;
          bot.windupTarget = { x: bot.lastSeenX, z: bot.lastSeenZ };
          actions.push({ type: 'windup', bot });
          continue;
        }
      }
      // Peek at a fresh last-seen position: lean out, look, pull back.
      if (now >= bot.peekCooldownUntil && now - bot.lastSeenAt < CFG.peekMemory) {
        const dx = bot.lastSeenX - bot.x;
        const dz = bot.lastSeenZ - bot.z;
        const d = Math.hypot(dx, dz);
        if (d > 5 && d < 30) {
          // Step out perpendicular to the sightline, 1.5 m toward the open side.
          const px = bot.x + (-dz / d) * 1.5;
          const pz = bot.z + (dx / d) * 1.5;
          bot.peekFrom = { x: bot.holdPos.x, z: bot.holdPos.z };
          bot.waypoints = [{ x: px, z: pz }];
          bot.wpIndex = 0;
          bot.peekUntil = now + range(ctx.rng, CFG.peekHoldMin, CFG.peekHoldMax);
          bot.state = 'peek';
          continue;
        }
      }
      // Planted spike: defenders on hold rotate to it.
      if (ctx.spike.planted && !bot.attacking) {
        bot.state = 'rotate';
        bot.waypoints = routeToPoint(bot, ctx.spike.x, ctx.spike.z);
        bot.wpIndex = 0;
      }
    }
  }
  return actions;
}

// The attacker team plants at a site; pick which site the team commits to this round.
export function teamSite(rng) {
  return chance(rng, 0.5) ? SITES.A : SITES.B;
}
