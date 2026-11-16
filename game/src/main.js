// Boot and the one loop, rebuilt for the threejs-fps-02 pivot: a fixed 60 Hz
// simulation feeding a render at the display's rate. The loop is split into three
// small jobs — advance the sim, sync the camera, draw the frame — so the pacing
// logic is easy to read and the shot mode can freeze it cleanly.
// ?shot=start|play|buy|end with &seed=N sets up a deterministic frame for a capture,
// renders it twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { mulberry32 } from './random.js';
import { createRender } from './render.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createGame } from './game.js';
import { runShot } from './shots.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const lowFx = params.get('fx') === 'low';
const rng = mulberry32(seed);

const render = createRender(
  document.getElementById('game'),
  document.getElementById('minimap'),
  { lowFx },
);
// Menu map overview: drawn once at boot (the canvas keeps it while the overlay
// is hidden and shown again).
render.drawMenuMap(document.getElementById('menu-map'));
const audio = createAudio();
const input = createInput(render.dom, onLockChange);
const game = createGame({ render, input, audio, rng });

window.__dustline = game.debug;

let frozen = false;
let accumulator = 0;
let lastTime = performance.now();
let menuYaw = 0.35;
let minimapAt = 0;

// Put the camera where the player is, or pan slowly across the yard on the menu.
function syncCamera() {
  const p = game.state.player;
  if (p) {
    render.setCamera(p.x, p.y + p.eye, p.z, p.yaw, p.pitch + p.pitchKick);
  } else {
    menuYaw += 0.00012;
    render.setCamera(2, 3.2, 21, menuYaw, -0.04);
  }
}

// Losing pointer lock pauses live play (but never a screenshot state).
function onLockChange(locked) {
  if (shot) return;
  const phase = game.state.phase;
  if (locked) {
    game.state.paused = false;
    game.hideOverlay();
  } else if (phase === 'playing') {
    game.state.paused = true;
    game.showOverlay(
      'pause',
      'Paused',
      'Pointer lock released. Click Resume to keep playing.',
      `Round ${game.state.round}  •  Vanguard ${game.state.score.vanguard} — ${game.state.score.jackals} Jackals`,
    );
  }
}

document.getElementById('play').addEventListener('click', () => {
  audio.ensure();
  const phase = game.state.phase;
  if (phase === 'menu' || phase === 'matchEnd') {
    game.startMatch();
    game.hideOverlay();
  }
  input.requestLock();
});

window.addEventListener('resize', () => render.resize());

// Run the fixed-step sim for the elapsed wall time (at most 5 steps a frame, so a
// slow frame never spirals into a long catch-up).
function advanceSim(dt) {
  const state = game.state;
  if (state.paused || state.phase === 'menu' || state.phase === 'matchEnd') return;
  accumulator += dt;
  let steps = 0;
  while (accumulator >= FIXED_STEP && steps < 5) {
    game.step(FIXED_STEP);
    accumulator -= FIXED_STEP;
    steps += 1;
  }
  if (accumulator > FIXED_STEP * 5) accumulator = 0;
}

// One rendered frame: sim, camera, bots, effects, the scene itself, the HUD, and
// the minimap at most every 100 ms.
function drawFrame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  const state = game.state;
  advanceSim(dt);
  syncCamera();
  // Aim-down-sights target for the renderer (eases the FOV and viewmodel).
  render.setAdsTarget(state.player && state.player.aiming ? 1 : 0);
  if (state.player) render.updateBots(state.bots, dt);
  render.updateFx(dt, state.time);
  render.render();
  game.refreshHud();
  if (now - minimapAt > 100) {
    minimapAt = now;
    render.drawMinimap(state);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (frozen) return;
  drawFrame(now);
}

syncCamera();
if (shot) {
  game.setShotMode(true);
  runShot(shot, { game, render, rng });
} else {
  requestAnimationFrame(frame);
}
