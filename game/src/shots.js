// Deterministic screenshot states (?shot=start|play|buy|end with &seed=N).
// Each state is built from the real game (same code paths as live play), rendered
// twice, then frozen with window.__shotReady set. No pointer lock is needed.
// Rebuilt for the threejs-fps-02 pivot: a shared setup helper does the common
// start-match / hide-overlay / place-player work, and each state only says what
// makes its frame different.
import { createWeapon } from './weapons.js';

export function runShot(name, ctx) {
  const { game, render } = ctx;
  const dbg = game.debug;
  const state = game.state;

  function settleCamera() {
    const p = state.player;
    render.setCamera(p.x, p.y + p.eye, p.z, p.yaw, p.pitch + p.pitchKick);
    render.updateBots(state.bots);
    render.scene.updateMatrixWorld(true);
  }

  function paintTwiceThenReady() {
    let painted = 0;
    function paint() {
      settleCamera();
      render.updateFx(1 / 60, state.time);
      render.render();
      render.drawMinimap(state);
      game.refreshHud();
      painted += 1;
      if (painted === 2) {
        window.__shotReady = true;
        return; // frozen: stop scheduling frames
      }
      requestAnimationFrame(paint);
    }
    requestAnimationFrame(paint);
  }

  // Start a match, hide the overlay, and put the player where the shot wants them.
  function beginShot(x, z, yaw, pitch) {
    dbg.startMatch();
    game.hideOverlay();
    dbg.teleport(x, z);
    state.player.yaw = yaw;
    state.player.pitch = pitch;
  }

  // Put a bot at a spot and face it north (toward the attackers' spawn).
  function placeBot(bot, x, z, alive = true) {
    bot.x = x;
    bot.z = z;
    bot.yaw = Math.PI;
    bot.alive = alive;
    bot.state = alive ? 'hold' : 'dead';
  }

  if (name === 'start') {
    // Title screen over the yard: match started, buy menu hidden, camera low and
    // angled toward the setting sun over the solar rows.
    beginShot(2, 20, 0.85, 0.03);
    document.getElementById('buy-menu').hidden = true;
    game.showOverlay(
      'start',
      'DUSTLINE',
      'A round-based tactical FPS in an abandoned solar yard at dusk. Four versus four, first to five rounds. Plant the spike — or stop it.',
      'WASD move  •  Mouse look  •  Click fire  •  R reload  •  E plant / defuse  •  B buy  •  G grenade',
    );
  } else if (name === 'play') {
    // Mid-round firefight: two Jackals in the Connector in front of the player,
    // an ally on the left, one round already fired (tracer + hitmarker visible).
    beginShot(0, 12, 0, 0);
    dbg.setMoney(1250);
    dbg.startRound();
    const enemies = state.bots.filter((b) => b.team === 'jackals');
    const allies = state.bots.filter((b) => b.isAlly);
    placeBot(enemies[0], 2, -6);
    placeBot(enemies[1], -3, -10);
    placeBot(enemies[2], 6, -14);
    placeBot(allies[0], 5, 6);
    // Give the player the rifle (same factory as the buy menu) and fire one aimed
    // round at the first Jackal.
    state.player.slots[1] = createWeapon('vk7');
    state.player.slot = 1;
    settleCamera();
    dbg.aimAt(enemies[0].x, 1.3, enemies[0].z);
    render.scene.updateMatrixWorld(true);
    dbg.shootOnce();
    // The hitmarker fades after 120 ms, but the frozen shot is captured later:
    // put it back on so the firefight read survives to the screenshot.
    setTimeout(() => document.getElementById('hitmarker').classList.add('on'), 300);
    // One enemy tracer back at the player, for a two-way firefight read.
    render.spawnTracer({ x: -3, y: 1.35, z: -10 }, { x: 0.4, y: 1.4, z: 11 }, 0xff9a5a);
    // The yard mid-fight: a smoke cloud blooming across the Connector and a
    // frag arcing in from a Jackal, so the frame reads as a live round — utility
    // in the air, not just two guns. The frag hangs high against the dusk sky
    // (top of its arc) so it silhouettes instead of vanishing against the sand.
    render.addSmoke(-2, -4);
    state.grenades.push({ kind: 'frag', x: 0.7, y: 2.6, z: 8.5, vx: 0, vy: 0, vz: 0, fuse: 5 });
  } else if (name === 'buy') {
    // Buy phase: menu open, $1,250 in hand, yard behind it. Step a few metres up
    // from spawn so the ally bots are behind the camera, out of frame.
    beginShot(0, 17, -0.15, 0.01);
    dbg.setMoney(1250);
    document.getElementById('buy-menu').hidden = false;
  } else if (name === 'end') {
    // Round won: Jackals eliminated, banner up, fallen Jackals in view.
    beginShot(0, 4, 0.15, -0.02);
    dbg.setMoney(1400);
    dbg.startRound();
    const enemies = state.bots.filter((b) => b.team === 'jackals');
    placeBot(enemies[0], 1.5, -4, false);
    placeBot(enemies[1], -2.5, -8, false);
    dbg.killAllEnemies();
    dbg.forceRoundEnd('vanguard', 'Jackals eliminated');
  } else {
    dbg.startMatch();
  }
  settleCamera();
  game.refreshHud();
  paintTwiceThenReady();
}
