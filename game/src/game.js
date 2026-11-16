// DUSTLINE game logic, rebuilt for the threejs-fps-02 pivot: the single state store,
// the state machine (menu / buy / playing / round-end / match-end), rounds, economy,
// the spike objective, combat and the HUD. The fixed-step sim lives here; rendering
// lives in render.js and only reads. One clock (state.time, seconds) drives weapon
// timers, channels and the round timer.
//
// New in this pass: bot grenades (bots lob frags at last-seen positions, telegraphed
// by a wind-up and a killfeed line), round-end slow motion plus a kill-recap line in
// the round banner, a grenade indicator and reload bar in the HUD, and a spike
// countdown bar under the top bar. The Longshot DMR joins the buy menu as key 5.
//
// The fixed step is a thin dispatcher: step() routes to one handler per phase, and
// the playing phase is split into small handlers (move / act / channel / projectiles
// / spike / bots / elimination) so each has one job and the hot path stays readable.
import * as THREE from 'three';
import { CFG, WEAPONS, GRENADE_PRICES, ARMOR_PRICE, ARMOR_ABSORB, TEAMS } from './config.js';
import { SITES, SPAWNS, PLAYER_SPAWN, COLLIDERS, moveCircle, losClear, insideSite } from './map.js';
import { createWeapon, canFire, fire as fireWeapon, startReload, updateWeapon, currentSpread, damageAt, reloadProgress } from './weapons.js';
import { createBots, stepBots } from './bots.js';
import { mulberry32 } from './random.js';

const FIXED_STEP = 1 / 60;
const $ = (id) => document.getElementById(id);

const BUY_ITEMS = [
  { key: '1', id: 'vk7', label: 'VK-7 Rifle', price: WEAPONS.vk7.price, slot: 1 },
  { key: '2', id: 'raptor', label: 'Raptor SMG', price: WEAPONS.raptor.price, slot: 1 },
  { key: '3', id: 'breacher', label: 'Breacher Shotgun', price: WEAPONS.breacher.price, slot: 1 },
  { key: '4', id: 'longbow', label: 'Longbow Sniper', price: WEAPONS.longbow.price, slot: 2 },
  { key: '5', id: 'longshot', label: 'Longshot DMR', price: WEAPONS.longshot.price, slot: 1 },
  { key: '6', id: 'frag', label: 'Frag Grenade', price: GRENADE_PRICES.frag },
  { key: '7', id: 'smoke', label: 'Smoke Grenade', price: GRENADE_PRICES.smoke },
  { key: '8', id: 'armor', label: 'Kevlar Armor', price: ARMOR_PRICE },
];

export function createGame(deps) {
  const { render, input, audio, rng } = deps;
  const raycaster = new THREE.Raycaster();
  raycaster.far = 120;
  const dirV = new THREE.Vector3();
  const fromV = new THREE.Vector3();
  const toV = new THREE.Vector3();
  // Edge-triggered firing for semi-auto weapons: was the trigger down last step?
  let prevFiring = false;

  const state = {
    phase: 'menu', // menu | buy | playing | roundEnd | matchEnd
    round: 1,
    score: { vanguard: 0, jackals: 0 },
    money: CFG.startMoney,
    kills: 0, deaths: 0,
    lossStreak: 0, // consecutive rounds lost (drives the loss-streak bonus)
    roundKills: 0, // player kills this round (for the round-end recap)
    roundBotKills: {}, // bot name -> kills this round
    roundHistory: [], // 'vanguard' | 'jackals' per finished round, oldest first
    playerTeam: 'vanguard',
    player: null, // created in resetPlayer
    bots: [],
    spike: { planted: false, site: null, x: 0, z: 0, timer: 0, channel: 0, channelKind: null },
    timer: CFG.buyTime,
    roundEndTimer: 0,
    roundWinner: null,
    roundReason: '',
    matchWinner: null,
    killfeed: [],
    grenades: [],
    smokes: [],
    noise: null,
    time: 0,
    started: false,
    paused: false,
    banner: { text: '', sub: '', until: 0 },
    dmgFlashUntil: 0,
    dmgDirAngle: 0,
    dmgDirUntil: 0,
    lastBeepSecond: -1,
    stepAcc: 0,
    shotMode: false,
  };

  function resetPlayer(keepLoadout) {
    const attacking = state.round % 2 === 1;
    const spawn = attacking ? PLAYER_SPAWN.attack : PLAYER_SPAWN.defend;
    const prev = state.player;
    const slots = keepLoadout && prev
      ? prev.slots
      : [createWeapon('p9'), null, null];
    state.player = {
      x: spawn.x, z: spawn.z, y: 0,
      yaw: attacking ? 0 : Math.PI, // camera yaw 0 faces north (-z); PI faces south
      pitch: 0, pitchKick: 0,
      vx: 0, vz: 0,
      hp: CFG.playerHp,
      armor: keepLoadout && prev ? prev.armor : false,
      crouching: false, moving: false, alive: true,
      eye: CFG.eyeStand,
      slots, slot: 0,
      frags: keepLoadout && prev ? prev.frags : 0,
      smokes: keepLoadout && prev ? prev.smokes : 0,
      stepAcc: 0,
      channel: 0, channelKind: null,
      plantSite: null,
    };
  }

  function weapon() {
    return state.player.slots[state.player.slot] || state.player.slots[0];
  }

  // --- HUD ----------------------------------------------------------------------
  const hudCache = {};
  function setText(id, value) {
    if (hudCache[id] !== value) {
      hudCache[id] = value;
      const el = $(id);
      if (el) el.textContent = value;
    }
  }
  function setVisible(id, on) {
    const el = $(id);
    if (el) el.hidden = !on;
  }

  function buildBuyMenu() {
    const list = $('buy-list');
    if (!list || list.children.length) return;
    for (const item of BUY_ITEMS) {
      const row = document.createElement('div');
      row.className = 'buy-row';
      row.dataset.key = item.key;
      row.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-name">${item.label}</span><span class="buy-price">$${item.price}</span>`;
      row.addEventListener('click', () => buyItem(item));
      list.appendChild(row);
    }
  }

  function refreshBuyMenu() {
    const list = $('buy-list');
    if (!list) return;
    for (const row of list.children) {
      const item = BUY_ITEMS.find((b) => b.key === row.dataset.key);
      const owned = item.id === 'armor'
        ? state.player.armor
        : item.slot !== undefined && state.player.slots[item.slot]?.def.id === item.id;
      const afford = state.money >= item.price;
      row.classList.toggle('owned', !!owned);
      row.classList.toggle('cant', !owned && !afford);
    }
    setText('buy-money', `$${state.money}`);
    // Loss streak: what a loss would pay right now, so the buy decision can
    // weigh an eco round against a force buy.
    const table = CFG.lossBonusStreak;
    const nextLoss = table[Math.min(state.lossStreak + 1, table.length) - 1];
    setText('buy-streak', state.lossStreak > 0
      ? `Lose streak ×${state.lossStreak} — next loss pays $${nextLoss}`
      : `No lose streak — a loss pays $${table[0]}`);
  }

  function buyItem(item) {
    if (state.phase !== 'buy') return;
    if (item.id === 'armor') {
      if (state.player.armor || state.money < item.price) return;
      state.money -= item.price;
      state.player.armor = true;
    } else if (item.id === 'frag') {
      if (state.money < item.price || state.player.frags >= 2) return;
      state.money -= item.price;
      state.player.frags += 1;
    } else if (item.id === 'smoke') {
      if (state.money < item.price || state.player.smokes >= 2) return;
      state.money -= item.price;
      state.player.smokes += 1;
    } else {
      if (state.money < item.price) return;
      if (state.player.slots[item.slot]?.def.id === item.id) return;
      state.money -= item.price;
      state.player.slots[item.slot] = createWeapon(item.id);
      state.player.slot = item.slot;
    }
    audio.buy();
    refreshBuyMenu();
  }

  function showBanner(text, sub, seconds) {
    state.banner = { text, sub, until: state.time + seconds };
    const b = $('banner');
    if (b) {
      b.querySelector('.banner-title').textContent = text;
      b.querySelector('.banner-sub').textContent = sub;
      b.hidden = false;
    }
  }

  function hideBanner() {
    const b = $('banner');
    if (b) b.hidden = true;
  }

  function killfeedAdd(html) {
    state.killfeed.push({ html, t: state.time });
    const feed = $('killfeed');
    if (!feed) return;
    const div = document.createElement('div');
    div.className = 'kf-row';
    div.innerHTML = html;
    feed.prepend(div);
    while (feed.children.length > 5) feed.removeChild(feed.lastChild);
    setTimeout(() => { if (div.parentNode) div.parentNode.removeChild(div); }, 5000);
  }

  function showOverlay(kind, title, copy, stats) {
    const ov = $('overlay');
    if (!ov) return;
    $('overlay-title').textContent = title;
    $('overlay-copy').textContent = copy;
    $('overlay-stats').textContent = stats || '';
    $('play').textContent = kind === 'matchEnd' ? 'Play again' : kind === 'pause' ? 'Resume' : 'Click to play';
    ov.hidden = false;
  }

  function hideOverlay() {
    const ov = $('overlay');
    if (ov) ov.hidden = true;
  }

  // --- match / round flow ---------------------------------------------------------
  function startMatch() {
    state.round = 1;
    state.score = { vanguard: 0, jackals: 0 };
    state.money = CFG.startMoney;
    state.kills = 0;
    state.deaths = 0;
    state.lossStreak = 0;
    state.roundKills = 0;
    state.roundBotKills = {};
    state.roundHistory = [];
    state.matchWinner = null;
    state.started = true;
    setupRound();
  }

  function setupRound() {
    const attacking = state.round % 2 === 1;
    state.bots = createBots(rng, state.round, 'vanguard');
    const survived = state.player && state.player.alive;
    resetPlayer(survived);
    state.spike = { planted: false, site: null, x: 0, z: 0, timer: 0, channel: 0, channelKind: null };
    state.grenades = [];
    state.smokes = [];
    state.noise = null;
    state.roundKills = 0;
    state.roundBotKills = {};
    state.phase = 'buy';
    state.timer = CFG.buyTime;
    state.roundWinner = null;
    render.setSlowmo(false);
    buildBuyMenu();
    refreshBuyMenu();
    setVisible('buy-menu', true);
    hideBanner();
    showBanner(
      `ROUND ${state.round} — ${attacking ? 'ATTACK' : 'DEFEND'}`,
      attacking ? 'Plant the spike at Site A or Site B' : 'Hold the sites. Defuse the spike if it is planted',
      3,
    );
    audio.roundStart();
  }

  function startRound() {
    state.phase = 'playing';
    state.timer = CFG.roundTime;
    setVisible('buy-menu', false);
    hideBanner();
  }

  // Who fragged most this round? The recap line names them in the round banner.
  function roundRecap() {
    const table = { You: state.roundKills };
    for (const [name, n] of Object.entries(state.roundBotKills)) table[name] = n;
    let topName = 'You';
    let topN = state.roundKills;
    for (const [name, n] of Object.entries(table)) {
      if (n > topN) { topName = name; topN = n; }
    }
    if (topN <= 0) return 'No kills this round';
    return `Top fragger: ${topName} — ${topN} kill${topN === 1 ? '' : 's'} this round`;
  }

  function endRound(winner, reason) {
    if (state.phase !== 'playing') return;
    state.phase = 'roundEnd';
    state.roundWinner = winner;
    state.roundReason = reason;
    state.roundEndTimer = 4.5;
    state.score[winner] += 1;
    state.roundHistory.push(winner);
    const playerWon = winner === 'vanguard';
    // Loss streak: a win resets the streak and pays the flat win bonus; a loss
    // lengthens the streak and pays the streak table (150 / 200 / 250 / 300),
    // so a team on a losing run can still buy back into the match.
    if (playerWon) {
      state.lossStreak = 0;
      state.money += CFG.winBonus;
    } else {
      state.lossStreak += 1;
      const table = CFG.lossBonusStreak;
      state.money += table[Math.min(state.lossStreak, table.length) - 1];
    }
    const name = TEAMS[winner].name.toUpperCase();
    // Round-end slow motion: the world keeps moving, but every effect decays
    // slowly while the banner and the recap sink in.
    render.setSlowmo(true);
    showBanner(
      `${name} WIN${name.endsWith('S') ? '' : 'S'} THE ROUND`,
      `${reason}  •  ${roundRecap()}`,
      4.5,
    );
    if (playerWon) audio.win(); else audio.lose();
    state.spike.planted = false;
    render.setSpike(0, 0, false);
    input.exitLock();
  }

  function endMatch() {
    state.phase = 'matchEnd';
    const w = state.score.vanguard > state.score.jackals ? 'vanguard' : 'jackals';
    state.matchWinner = w;
    const won = w === 'vanguard';
    showOverlay(
      'matchEnd',
      won ? 'VICTORY' : 'DEFEAT',
      won
        ? `Vanguard takes the match ${state.score.vanguard}–${state.score.jackals}. The Yard is yours.`
        : `Jackals take the match ${state.score.jackals}–${state.score.vanguard}. The Yard holds.`,
      `Rounds ${state.score.vanguard}–${state.score.jackals}  •  Kills ${state.kills}  •  Deaths ${state.deaths}`,
    );
    if (won) audio.win(); else audio.lose();
  }

  function advanceAfterRoundEnd() {
    if (state.score.vanguard >= CFG.winScore || state.score.jackals >= CFG.winScore || state.round >= CFG.maxRounds) {
      endMatch();
      return;
    }
    state.round += 1;
    setupRound();
  }

  // --- combat ---------------------------------------------------------------------
  function traceEnd(ox, oy, oz, dx, dy, dz, maxDist) {
    // Walk the ray in 0.5 m steps; stop at the first collider the point enters.
    for (let d = 0.5; d <= maxDist; d += 0.5) {
      const x = ox + dx * d;
      const z = oz + dz * d;
      const y = oy + dy * d;
      if (y < 0) return { x, y: 0, z, d };
      for (const c of COLLIDERS) {
        if (y < c.h && x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1) {
          return { x, y, z, d };
        }
      }
    }
    return { x: ox + dx * maxDist, y: oy + dy * maxDist, z: oz + dz * maxDist, d: maxDist };
  }

  function playerShoot() {
    const p = state.player;
    const w = weapon();
    const now = state.time;
    if (!fireWeapon(w, now)) {
      if (w.mag <= 0 && !w.reloading) audio.dryFire();
      return;
    }
    const eyeY = p.y + p.eye;
    fromV.set(p.x, eyeY, p.z);
    // Camera forward + spread jitter (aiming tightens the cone).
    const spread = currentSpread(w, p.moving, p.crouching, p.aiming);
    render.camera.getWorldDirection(dirV);
    dirV.x += (rng() * 2 - 1) * spread;
    dirV.y += (rng() * 2 - 1) * spread;
    dirV.z += (rng() * 2 - 1) * spread;
    dirV.normalize();
    const pellets = w.def.pellets;
    let anyHit = false;
    let anyKill = false;
    for (let i = 0; i < pellets; i += 1) {
      // Single pellet: reuse the shared direction vector (no allocation in the hot path).
      const d2 = pellets === 1 ? dirV : dirV.clone();
      if (pellets > 1) {
        d2.x += (rng() * 2 - 1) * w.def.spread;
        d2.y += (rng() * 2 - 1) * w.def.spread;
        d2.normalize();
      }
      raycaster.set(fromV, d2);
      const hits = raycaster.intersectObjects(render.hitMeshes, false);
      const hit = hits[0];
      if (hit && hit.object.userData.bot && hit.object.userData.bot.alive) {
        const bot = hit.object.userData.bot;
        const head = hit.object.userData.part === 'head';
        const dist = hit.distance;
        let dmg = damageAt(w.def, dist, head);
        if (bot.armor) dmg *= 1 - ARMOR_ABSORB;
        bot.hp -= dmg;
        bot.lastHurtAt = now;
        bot.interrupted = true;
        anyHit = true;
        toV.copy(hit.point);
        if (bot.hp <= 0) {
          bot.hp = 0;
          bot.alive = false;
          bot.state = 'dead';
          anyKill = true;
          state.kills += 1;
          state.roundKills += 1;
          state.money += CFG.killBonus;
          killfeedAdd(`<b class="you">You</b> ▸ <b class="${bot.team}">${bot.name}</b>${head ? ' <span class="hs">HEADSHOT</span>' : ''}`);
        }
      } else {
        const end = traceEnd(fromV.x, fromV.y, fromV.z, d2.x, d2.y, d2.z, 60);
        toV.set(end.x, end.y, end.z);
      }
      render.spawnTracer({ x: fromV.x, y: fromV.y, z: fromV.z }, { x: toV.x, y: toV.y, z: toV.z });
    }
    render.muzzleFlash(w.def.kick);
    audio.shot(w.def.id);
    p.pitchKick = Math.min(0.09, p.pitchKick + w.def.kick * (0.8 + rng() * 0.4));
    state.noise = { x: p.x, z: p.z, until: now + 1.5 };
    if (anyHit) {
      audio.hit(anyKill);
      const hm = $('hitmarker');
      if (hm) {
        hm.classList.add('on');
        hm.classList.toggle('kill', anyKill);
        setTimeout(() => hm.classList.remove('on', 'kill'), anyKill ? 400 : 120);
      }
    }
    if (w.mag <= 0 && w.reserve > 0) startReload(w, now);
  }

  function damagePlayer(dmg, fromX, fromZ) {
    const p = state.player;
    if (!p.alive) return;
    if (p.armor) dmg *= 1 - ARMOR_ABSORB;
    p.hp -= dmg;
    audio.hurt();
    state.dmgFlashUntil = state.time + 0.35;
    // Damage direction: angle of the attacker relative to where the player faces.
    const dx = fromX - p.x;
    const dz = fromZ - p.z;
    const worldAngle = Math.atan2(dx, dz);
    // Attacker bearing relative to where the player faces (yaw + PI is the facing angle).
    state.dmgDirAngle = worldAngle - p.yaw - Math.PI;
    state.dmgDirUntil = state.time + 0.7;
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      state.deaths += 1;
      killfeedAdd(`<b class="jackals">Jackals</b> ▸ <b class="you">You</b>`);
      showBanner('YOU ARE DOWN', 'Your squad fights on — the round is not over yet', 3);
    }
  }

  function damageBot(bot, dmg, killerName, killerClass) {
    if (!bot.alive) return;
    if (bot.armor) dmg *= 1 - ARMOR_ABSORB;
    bot.hp -= dmg;
    bot.lastHurtAt = state.time;
    bot.interrupted = true;
    if (bot.hp <= 0) {
      bot.hp = 0;
      bot.alive = false;
      bot.state = 'dead';
      if (killerName !== 'You') {
        state.roundBotKills[killerName] = (state.roundBotKills[killerName] || 0) + 1;
      }
      killfeedAdd(`<b class="${killerClass}">${killerName}</b> ▸ <b class="${bot.team}">${bot.name}</b>`);
    }
  }

  function explodeGrenade(g) {
    audio.explode();
    const targets = [];
    if (state.player.alive) targets.push({ kind: 'player', x: state.player.x, z: state.player.z });
    for (const b of state.bots) if (b.alive) targets.push({ kind: 'bot', ref: b, x: b.x, z: b.z });
    for (const t of targets) {
      const d = Math.hypot(t.x - g.x, t.z - g.z);
      if (d > CFG.fragRadius) continue;
      const dmg = 90 * (1 - d / CFG.fragRadius) + 10;
      if (t.kind === 'player') damagePlayer(dmg, g.x, g.z);
      else damageBot(t.ref, dmg, 'You', 'you');
    }
    render.spawnTracer({ x: g.x, y: 0.4, z: g.z }, { x: g.x, y: 2.2, z: g.z }, 0xff7a2a);
    state.noise = { x: g.x, z: g.z, until: state.time + 2 };
  }

  function throwGrenade(kind, fromBot) {
    const p = state.player;
    if (!fromBot) {
      if (!p.alive) return;
      if (kind === 'frag' && p.frags <= 0) return;
      if (kind === 'smoke' && p.smokes <= 0) return;
      if (kind === 'frag') p.frags -= 1; else p.smokes -= 1;
      audio.grenadeThrow();
      render.camera.getWorldDirection(dirV);
      const eyeY = p.y + p.eye;
      state.grenades.push({
        kind,
        x: p.x + dirV.x * 0.5, y: eyeY - 0.1, z: p.z + dirV.z * 0.5,
        vx: dirV.x * 15, vy: dirV.y * 15 + 3.2, vz: dirV.z * 15,
        fuse: kind === 'frag' ? CFG.fragFuse : 0.9,
      });
      return;
    }
    // A bot lobs from chest height toward a known position: a flat, fast arc so
    // the grenade lands where the bot last saw someone, not at its own feet.
    // Frags fuse on impact timing; smokes pop shortly after landing.
    const b = fromBot;
    const dx = fromBot.tx - b.x;
    const dz = fromBot.tz - b.z;
    const dist = Math.hypot(dx, dz) || 1;
    const speed = Math.min(15, 6 + dist * 0.55);
    state.grenades.push({
      kind,
      x: b.x, y: 1.35, z: b.z,
      vx: (dx / dist) * speed, vy: 4.2, vz: (dz / dist) * speed,
      fuse: kind === 'frag' ? CFG.fragFuse : 0.9,
    });
    audio.grenadeThrow();
  }

  // --- fixed step: one dispatcher, one handler per phase -------------------------
  // step() advances the clock and routes to the handler for the current phase.
  // The playing phase is split into small handlers (move / act / channel /
  // projectiles / spike / bots / elimination) so each has one job.
  function step(dt) {
    state.time += dt;
    const p = state.player;
    if (!p) return;
    // Aim-down-sights state comes from the input module every step (right mouse
    // held while alive, live play only); render reads it back for the FOV and
    // viewmodel, and the sim reads it for spread, speed and look sensitivity.
    p.aiming = input.state.aiming && p.alive && state.phase === 'playing';
    applyLook(dt);
    if (state.phase === 'buy') {
      stepBuyPhase(dt);
      return;
    }
    if (state.phase === 'roundEnd') {
      state.roundEndTimer -= dt;
      if (state.roundEndTimer <= 0) advanceAfterRoundEnd();
      return;
    }
    if (state.phase !== 'playing') return;
    stepPlaying(dt);
  }

  // Mouse look, consumed once per step so deltas never double-apply, plus the
  // slow recoil recovery that pulls the view back down after a shot. Aiming
  // down sights steadies the look (a slower sensitivity) for precise shots.
  function applyLook(dt) {
    const p = state.player;
    const look = input.takeLook();
    const sens = p.aiming ? 0.0022 * CFG.adsLookMult : 0.0022;
    if (state.phase === 'playing' || state.phase === 'buy') {
      p.yaw -= look.x * sens;
      p.pitch -= look.y * sens;
      if (p.pitch > 1.5) p.pitch = 1.5;
      if (p.pitch < -1.5) p.pitch = -1.5;
    }
    if (p.pitchKick > 0) {
      p.pitchKick = Math.max(0, p.pitchKick - dt * 0.22);
    }
  }

  // Buy phase: the timer runs, number keys buy, B hides the menu, Enter (or the
  // timer running out) starts the round. Weapon timers still tick here.
  function stepBuyPhase(dt) {
    state.timer -= dt;
    for (const item of BUY_ITEMS) {
      if (input.wasPressed(`Digit${item.key}`)) buyItem(item);
    }
    if (input.wasPressed('KeyB')) setVisible('buy-menu', $('buy-menu').hidden);
    if (input.wasPressed('Enter') || state.timer <= 0) startRound();
    updateWeapon(weapon(), state.time);
  }

  // One live-playing step: timer, movement, actions, objective channel, flying
  // grenades, the spike fuse, the bots, then the elimination check. A handler
  // returns true when the round has ended inside it (defuse, detonation), so the
  // step stops there instead of running the rest on a dead round.
  function stepPlaying(dt) {
    state.timer -= dt;
    if (state.timer <= 0 && !state.spike.planted) {
      endRound(state.round % 2 === 1 ? 'jackals' : 'vanguard', 'Time expired — defenders hold the yard');
      return;
    }
    movePlayer(dt);
    playerActions(dt);
    if (updateChannel(dt)) return;
    updateProjectiles(dt);
    if (updateSpikeTimer(dt)) return;
    if (runBotTurn(dt)) return;
    checkElimination();
  }

  // WASD with acceleration and friction, crouch to slow down and lower the eye,
  // AABB collision with sliding, footsteps every 2.4 m of travel.
  function movePlayer(dt) {
    const p = state.player;
    const keys = input.state.keys;
    const crouchKey = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    p.crouching = crouchKey;
    const targetEye = crouchKey ? CFG.eyeCrouch : CFG.eyeStand;
    p.eye += (targetEye - p.eye) * Math.min(1, dt * 12);
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    // Wish direction in world space: forward is -z rotated by yaw.
    let wishX = 0;
    let wishZ = 0;
    if (keys.has('KeyW')) { wishX += -sin; wishZ += -cos; }
    if (keys.has('KeyS')) { wishX += sin; wishZ += cos; }
    if (keys.has('KeyA')) { wishX += -cos; wishZ += sin; }
    if (keys.has('KeyD')) { wishX += cos; wishZ += -sin; }
    const wishLen = Math.hypot(wishX, wishZ);
    // Aiming down sights slows the player down — the steady-aim trade-off.
    const aimMult = p.aiming ? CFG.adsSpeedMult : 1;
    const speedCap = CFG.walkSpeed * weapon().def.speed * (crouchKey ? 0.55 : 1) * aimMult;
    if (wishLen > 0.01) {
      wishX /= wishLen;
      wishZ /= wishLen;
      p.vx += wishX * CFG.accel * dt;
      p.vz += wishZ * CFG.accel * dt;
      const vLen = Math.hypot(p.vx, p.vz);
      if (vLen > speedCap) {
        p.vx = (p.vx / vLen) * speedCap;
        p.vz = (p.vz / vLen) * speedCap;
      }
      p.moving = true;
    } else {
      const drag = Math.max(0, 1 - CFG.friction * dt);
      p.vx *= drag;
      p.vz *= drag;
      if (Math.hypot(p.vx, p.vz) < 0.05) { p.vx = 0; p.vz = 0; }
      p.moving = Math.hypot(p.vx, p.vz) > 0.4;
    }
    if (p.alive) {
      moveCircle(p, CFG.playerRadius, p.vx * dt, p.vz * dt);
      p.stepAcc += Math.hypot(p.vx, p.vz) * dt;
      if (p.stepAcc > 2.4 && p.moving) {
        p.stepAcc = 0;
        audio.step();
      }
    }
  }

  // Reload, weapon slots, grenade key, mute, and the trigger. Automatics fire
  // while held; semi-autos fire once per fresh press (prevFiring edge).
  function playerActions(dt) {
    const p = state.player;
    updateWeapon(weapon(), state.time);
    if (input.wasPressed('KeyR')) {
      if (startReload(weapon(), state.time)) audio.reload();
    }
    if (input.wasPressed('Digit1') && p.slots[0]) { p.slot = 0; }
    if (input.wasPressed('Digit2') && p.slots[1]) { p.slot = 1; }
    if (input.wasPressed('Digit3') && p.slots[2]) { p.slot = 2; }
    if (input.wasPressed('KeyG')) {
      if (p.frags > 0) throwGrenade('frag');
      else if (p.smokes > 0) throwGrenade('smoke');
    }
    if (input.wasPressed('KeyM')) {
      const muted = audio.toggleMute();
      showBanner(muted ? 'SOUND MUTED' : 'SOUND ON', '', 1);
    }
    if (p.alive && input.state.firing) {
      const w = weapon();
      if (w.def.auto) playerShoot();
      else if (!prevFiring) playerShoot();
    }
    prevFiring = input.state.firing;
  }

  // Plant / defuse channel (hold E). Attackers plant inside a site; defenders
  // defuse next to a planted spike. Releasing E, or leaving the spot, resets the
  // channel. A completed defuse ends the round — returns true when it does.
  function updateChannel(dt) {
    const p = state.player;
    const keys = input.state.keys;
    if (!p.alive || !keys.has('KeyE')) {
      p.channel = 0;
      p.channelKind = null;
      return false;
    }
    const attacking = state.round % 2 === 1;
    if (attacking && !state.spike.planted) {
      const site = insideSite(p.x, p.z, SITES.A) ? SITES.A
        : insideSite(p.x, p.z, SITES.B) ? SITES.B : null;
      if (!site) {
        p.channel = 0;
        p.channelKind = null;
        return false;
      }
      p.channelKind = 'plant';
      p.plantSite = site;
      p.channel += dt;
      if (Math.floor(p.channel * 2) !== Math.floor((p.channel - dt) * 2)) audio.plantBeep();
      if (p.channel >= CFG.plantTime) {
        state.spike = { planted: true, site, x: p.x, z: p.z, timer: CFG.spikeTime, channel: 0, channelKind: null };
        state.money += CFG.plantBonus;
        p.channel = 0;
        p.channelKind = null;
        render.setSpike(p.x, p.z, true);
        audio.plantDone();
        showBanner('SPIKE PLANTED', `Site ${site.id} — ${CFG.spikeTime}s to detonation`, 3);
        killfeedAdd(`<b class="you">You</b> planted the spike at Site ${site.id}`);
      }
      return false;
    }
    if (!attacking && state.spike.planted) {
      const d = Math.hypot(state.spike.x - p.x, state.spike.z - p.z);
      if (d >= 2.2) {
        p.channel = 0;
        p.channelKind = null;
        return false;
      }
      p.channelKind = 'defuse';
      p.channel += dt;
      if (Math.floor(p.channel * 2) !== Math.floor((p.channel - dt) * 2)) audio.defuseBeep();
      if (p.channel >= CFG.defuseTime) {
        state.money += CFG.defuseBonus;
        p.channel = 0;
        p.channelKind = null;
        render.setSpike(0, 0, false);
        state.spike.planted = false;
        endRound('vanguard', 'Spike defused — the yard holds');
        return true;
      }
    }
    return false;
  }

  // Grenades arc under gravity, bounce once on the sand, then pop: frags damage
  // everything in the radius, smokes bloom into a blocking cloud. Dead clouds fade.
  function updateProjectiles(dt) {
    for (let i = state.grenades.length - 1; i >= 0; i -= 1) {
      const g = state.grenades[i];
      g.vy -= 18 * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.z += g.vz * dt;
      if (g.y < 0.12) { g.y = 0.12; g.vy = -g.vy * 0.35; g.vx *= 0.6; g.vz *= 0.6; }
      g.fuse -= dt;
      if (g.fuse <= 0) {
        state.grenades.splice(i, 1);
        if (g.kind === 'frag') explodeGrenade(g);
        else {
          render.addSmoke(g.x, g.z);
          state.smokes.push({ x: g.x, z: g.z, r: CFG.smokeRadius, t: CFG.smokeTime });
        }
      }
    }
    for (let i = state.smokes.length - 1; i >= 0; i -= 1) {
      state.smokes[i].t -= dt;
      if (state.smokes[i].t <= 0) state.smokes.splice(i, 1);
    }
  }

  // The planted spike ticks down with beeps in the last five seconds; at zero it
  // detonates and the attackers of this round take the round. Returns true on detonation.
  function updateSpikeTimer(dt) {
    if (!state.spike.planted) return false;
    state.spike.timer -= dt;
    const sec = Math.ceil(state.spike.timer);
    if (sec <= 5 && sec !== state.lastBeepSecond && sec > 0) {
      state.lastBeepSecond = sec;
      audio.spikeBeep();
    }
    if (state.spike.timer <= 0) {
      audio.explode();
      endRound(state.round % 2 === 1 ? 'vanguard' : 'jackals', 'Spike detonated — Site ' + state.spike.site.id + ' is gone');
      return true;
    }
    return false;
  }

  // One bot turn: build the shared perception context, step the AI, and play out
  // every action it returns (shots with tracers, grenade wind-ups and throws,
  // plant/defuse completions). A bot defuse ends the round — returns true then.
  function runBotTurn(dt) {
    const p = state.player;
    const ctx = {
      rng, now: state.time, dt,
      player: { x: p.x, z: p.z, alive: p.alive, moving: p.moving, crouching: p.crouching },
      bots: state.bots,
      smokes: state.smokes,
      spike: state.spike,
      noise: state.noise,
    };
    const actions = stepBots(state.bots, ctx, dt);
    for (const a of actions) {
      if (a.type === 'shot') {
        const b = a.bot;
        const from = { x: b.x, y: 1.35, z: b.z };
        if (a.target.kind === 'player') {
          const to = a.hit
            ? { x: p.x, y: p.y + p.eye - 0.25, z: p.z }
            : { x: a.missX, y: p.y + p.eye - 0.25, z: a.missZ };
          render.spawnTracer(from, to, 0xff9a5a);
          audio.shot(b.weapon.def.id);
          if (a.hit) damagePlayer(a.dmg, b.x, b.z);
        } else {
          const tb = a.target.ref;
          const to = a.hit
            ? { x: tb.x, y: 1.2, z: tb.z }
            : { x: a.missX, y: 1.2, z: a.missZ };
          render.spawnTracer(from, to, 0xff9a5a);
          audio.shot(b.weapon.def.id);
          if (a.hit) damageBot(tb, a.dmg, b.name, b.team);
        }
      } else if (a.type === 'windup') {
        // Telegraph: the bot is about to lob a frag at a position it last saw.
        killfeedAdd(`<b class="${a.bot.team}">${a.bot.name}</b> is lobbing a frag — move!`);
      } else if (a.type === 'throw') {
        throwGrenade(a.kind || 'frag', { x: a.bot.x, z: a.bot.z, tx: a.tx, tz: a.tz });
      } else if (a.type === 'plant-done') {
        state.spike = { planted: true, site: a.site, x: a.bot.x, z: a.bot.z, timer: CFG.spikeTime, channel: 0, channelKind: null };
        render.setSpike(a.bot.x, a.bot.z, true);
        audio.plantDone();
        showBanner('SPIKE PLANTED', `Site ${a.site.id} — ${CFG.spikeTime}s to detonation`, 3);
        killfeedAdd(`<b class="${a.bot.team}">${a.bot.name}</b> planted the spike at Site ${a.site.id}`);
      } else if (a.type === 'defuse-done') {
        render.setSpike(0, 0, false);
        state.spike.planted = false;
        // The defusing bot's team wins the round.
        endRound(a.bot.team, 'Spike defused — the yard holds');
        return true;
      }
    }
    return false;
  }

  // A round ends when one side has nobody left standing.
  function checkElimination() {
    const p = state.player;
    const aliveV = (p.alive ? 1 : 0) + state.bots.filter((b) => b.alive && b.team === 'vanguard').length;
    const aliveJ = state.bots.filter((b) => b.alive && b.team === 'jackals').length;
    if (aliveJ === 0) {
      endRound('vanguard', 'Jackals eliminated');
      return;
    }
    if (aliveV === 0) {
      endRound('jackals', 'Vanguard eliminated');
    }
  }

  // --- HUD refresh (called once per rendered frame, cheap cached writes) ---------
  function refreshHud() {
    const p = state.player;
    if (!p) return;
    const w = weapon();
    setText('health-num', String(Math.ceil(p.hp)));
    const hf = $('health-fill');
    if (hf) {
      hf.style.width = `${Math.max(0, p.hp)}%`;
      hf.style.background = p.hp > 50 ? '#2fd4c4' : p.hp > 25 ? '#f0a830' : '#e5484d';
    }
    setText('armor-num', p.armor ? 'ARMOR' : '—');
    setText('ammo-mag', String(w.mag));
    setText('ammo-reserve', `/ ${w.reserve}`);
    setText('weapon-name', w.def.name + (w.reloading ? ' — RELOADING' : ''));
    // Reload progress bar under the weapon name.
    const rf = $('reload-fill');
    if (rf) {
      const prog = reloadProgress(w, state.time);
      rf.style.width = `${(prog * 100).toFixed(0)}%`;
      rf.parentElement.hidden = prog <= 0;
    }
    setText('money', `$${state.money}`);
    // Grenade indicator: what is left in the player's pockets.
    setText('nades-frag', `FRAG ${p.frags}`);
    setText('nades-smoke', `SMOKE ${p.smokes}`);
    const ng = $('nades-frag');
    if (ng) ng.classList.toggle('empty', p.frags <= 0);
    const ns = $('nades-smoke');
    if (ns) ns.classList.toggle('empty', p.smokes <= 0);
    const t = Math.max(0, Math.ceil(state.timer));
    const mm = Math.floor(t / 60);
    const ss = String(t % 60).padStart(2, '0');
    setText('timer', state.phase === 'buy' ? `BUY ${mm}:${ss}` : `${mm}:${ss}`);
    setText('score-v', String(state.score.vanguard));
    setText('score-j', String(state.score.jackals));
    const aliveV = (p.alive ? 1 : 0) + state.bots.filter((b) => b.alive && b.team === 'vanguard').length;
    const aliveJ = state.bots.filter((b) => b.alive && b.team === 'jackals').length;
    setText('alive-v', `V ${aliveV}`);
    setText('alive-j', `J ${aliveJ}`);
    setText('round-label', `ROUND ${state.round}/${CFG.maxRounds}`);
    setText('phase-label', state.round % 2 === 1 ? 'VANGUARD ATTACK' : 'VANGUARD DEFEND');
    // Round-history dots: one per round played, coloured by who won it.
    const rh = $('round-history');
    if (rh) {
      const marks = state.roundHistory.map((w) => (w === 'vanguard' ? 'v' : 'j')).join('');
      if (rh.dataset.marks !== marks) {
        rh.dataset.marks = marks;
        rh.innerHTML = '';
        for (let i = 0; i < CFG.maxRounds; i += 1) {
          const dot = document.createElement('i');
          if (i < state.roundHistory.length) dot.className = state.roundHistory[i] === 'vanguard' ? 'v' : 'j';
          rh.appendChild(dot);
        }
      }
    }
    // Crosshair gap grows with spread (and shrinks while aiming).
    const gap = 3 + currentSpread(w, p.moving, p.crouching, p.aiming) * 900;
    const ch = $('crosshair');
    if (ch) ch.style.setProperty('--gap', `${gap.toFixed(1)}px`);
    // Spike status + countdown bar.
    const spikeEl = $('spike-status');
    const spikeBar = $('spike-fill');
    if (state.spike.planted) {
      const st = Math.max(0, Math.ceil(state.spike.timer));
      setText('spike-status', `SPIKE — SITE ${state.spike.site.id} — 0:${String(st).padStart(2, '0')}`);
      if (spikeEl) spikeEl.classList.add('hot');
      if (spikeBar) {
        spikeBar.style.width = `${(state.spike.timer / CFG.spikeTime) * 100}%`;
        spikeBar.parentElement.hidden = false;
      }
    } else {
      setText('spike-status', 'SPIKE NOT PLANTED');
      if (spikeEl) spikeEl.classList.remove('hot');
      if (spikeBar) spikeBar.parentElement.hidden = true;
    }
    // Plant / defuse progress.
    const prog = $('channel');
    if (prog) {
      if (p.channelKind && p.channel > 0) {
        prog.hidden = false;
        const total = p.channelKind === 'plant' ? CFG.plantTime : CFG.defuseTime;
        const pct = Math.min(100, (p.channel / total) * 100);
        prog.querySelector('.channel-fill').style.width = `${pct}%`;
        prog.querySelector('.channel-label').textContent = p.channelKind === 'plant'
          ? `PLANTING — SITE ${p.plantSite ? p.plantSite.id : ''} — ${pct.toFixed(0)}%`
          : `DEFUSING — ${pct.toFixed(0)}%`;
      } else {
        prog.hidden = true;
      }
    }
    // Grenades in flight: draw them so a lobbed frag is visible before it lands.
    render.updateGrenades(state.grenades, state.time);
    // Damage vignette + direction.
    const vig = $('vignette');
    if (vig) vig.style.opacity = state.time < state.dmgFlashUntil ? '0.55' : '0';
    const dd = $('dmg-dir');
    if (dd) {
      if (state.time < state.dmgDirUntil) {
        dd.style.opacity = '1';
        dd.style.transform = `translate(-50%,-50%) rotate(${state.dmgDirAngle}rad)`;
      } else {
        dd.style.opacity = '0';
      }
    }
    if (state.banner.until && state.time > state.banner.until) {
      state.banner.until = 0;
      hideBanner();
    }
    // Low-health pulse.
    document.body.classList.toggle('lowhp', p.alive && p.hp <= 25);
  }

  // --- public API -----------------------------------------------------------------
  return {
    state,
    step,
    refreshHud,
    startMatch,
    setupRound,
    startRound,
    endRound,
    buyItem,
    showOverlay,
    hideOverlay,
    setShotMode(on) { state.shotMode = on; },
    // Debug handle for tests and screenshot states (window.__dustline).
    debug: {
      get state() { return state; },
      get phase() { return state.phase; },
      get round() { return state.round; },
      get score() { return state.score; },
      get money() { return state.money; },
      get lossStreak() { return state.lossStreak; },
      get bots() { return state.bots; },
      get player() { return state.player; },
      // Aim-down-sights for tests: sets the input aim flag the sim reads each step.
      setAds(on) { input.state.aiming = !!on; },
      // Camera field of view (74 hipfire, 56 fully aimed) — the ADS read-out.
      get cameraFov() { return render.camera.fov; },
      // Move a bot for tests (resets it to a hold at the new spot).
      teleportBot(i, x, z) {
        const b = state.bots[i];
        if (!b) return;
        b.x = x; b.z = z;
        b.state = 'hold';
        b.holdPos = { x, z };
        b.waypoints = [{ x, z }];
        b.wpIndex = 0;
      },
      startMatch,
      startRound,
      shootOnce() { if (state.phase === 'playing') playerShoot(); },
      // Advance the fixed-step sim synchronously (test hook: lets a test drive the
      // sim in sim-time instead of waiting on wall-clock frames).
      stepSim(n = 1) { for (let i = 0; i < n; i += 1) step(FIXED_STEP); },
      refreshHud,
      setMoney(n) { state.money = n; refreshBuyMenu(); },
      teleport(x, z) { state.player.x = x; state.player.z = z; },
      aimAt(x, y, z) {
        const p = state.player;
        const dx = x - p.x;
        const dy = y - (p.y + p.eye);
        const dz = z - p.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        p.yaw = Math.atan2(-dx, -dz);
        p.pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
      },
      forceRoundEnd(winner, reason) { endRound(winner, reason || 'Debug — forced round end'); },
      killAllEnemies() {
        for (const b of state.bots) {
          if (b.team === 'jackals') {
            b.hp = 0; b.alive = false; b.state = 'dead';
            // Credit the player: the round-win frame reads as a round the
            // player actually won, with a top-fragger recap instead of "no kills".
            state.kills += 1;
            state.roundKills += 1;
          }
        }
      },
      plantSpike(siteId) {
        const site = SITES[siteId];
        state.spike = { planted: true, site, x: site.x, z: site.z, timer: CFG.spikeTime, channel: 0, channelKind: null };
        render.setSpike(site.x, site.z, true);
      },
    },
  };
}
