// Keyboard and mouse, plus the pointer lock that turns the mouse into look.
// Plain browser APIs only. Edge-triggered presses (reload, buy, plant…) are
// queued here and consumed by the sim once per fixed step, so a tap is never
// lost between frames.
//
// Two features live in this module because they only touch input state:
// - WALK (hold Alt): while Alt is held the movement keys report through the
//   sim's slow-move path. The sim reads crouch from the same key set and
//   caps speed at 0.55x with a steadier aim and a lower eye, so Alt reads as
//   a low, slow, deliberate walk — the only speed lever reachable from this
//   module without touching the sim. `walkScale()` exposes the factor (0.55
//   while walking, 1 otherwise) so the HUD or a future sim change can read
//   the same number instead of hard-coding it.
// - MINIMAP ZOOM (tap N): toggles a CSS class on the #minimap canvas. The
//   zoom rule is injected by this module (see ensureMinimapStyle) so no other
//   file has to know about it; render.js keeps drawing the same canvas.
//
// Control map (kept as data so the HUD or a help overlay can read it):
export const BINDINGS = Object.freeze({
  move: ['KeyW', 'KeyA', 'KeyS', 'KeyD'],
  walk: ['AltLeft', 'AltRight'],
  crouch: ['ControlLeft', 'ControlRight', 'KeyC'],
  jump: [], // DUSTLINE has no jump; kept so the map stays complete.
  reload: ['KeyR'],
  buyMenu: ['KeyB'],
  slots: ['Digit1', 'Digit2', 'Digit3'],
  grenade: ['KeyG'],
  plantDefuse: ['KeyE'],
  aim: ['Mouse2'], // hold right mouse to aim down sights
  mute: ['KeyM'],
  minimapZoom: ['KeyN'],
  fire: ['Mouse0'],
});

// The sim caps speed at 0.55x while the slow-move path is engaged. This must
// stay in sync with the factor the sim applies; it is defined once here.
export const WALK_SPEED_FACTOR = 0.55;

// The key set the sim reads. A plain Set with one override: while Alt is held,
// queries for the crouch keys also return true, which is how the walk
// modifier reaches the sim without any sim-side change. Direction keys are
// never altered — Alt changes speed only, never where you are heading.
class InputKeys extends Set {
  get walkHeld() {
    return super.has('AltLeft') || super.has('AltRight');
  }

  has(code) {
    if (code === 'ControlLeft' || code === 'ControlRight' || code === 'KeyC') {
      return super.has(code) || this.walkHeld;
    }
    return super.has(code);
  }
}

export function createInput(canvas, onLockChange) {
  const keys = new InputKeys();
  const pressed = new Set();
  const state = {
    keys,
    locked: false,
    firing: false,
    aiming: false, // true while the right mouse button is held (aim down sights)
    lookX: 0,
    lookY: 0,
    // True while Alt is held (derived from the key set, so it can never go
    // stale: releasing Alt, blurring the window or losing the lock clears it).
    get walkHeld() { return keys.walkHeld; },
    minimapZoomed: false,
    // Timestamp (ms) of the most recent key or mouse activity; idleSeconds()
    // reads it for AFK hints and menu timeouts.
    lastInputAt: 0,
  };

  function noteActivity() {
    state.lastInputAt = performance.now();
  }

  function setKey(event, down) {
    if (event.repeat) { event.preventDefault(); return; }
    noteActivity();
    if (down) {
      if (!keys.has(event.code)) pressed.add(event.code);
      keys.add(event.code);
    } else {
      keys.delete(event.code);
    }
    // Space/Tab scroll or focus the page; Alt grabs browser shortcuts.
    // All three must be swallowed while playing.
    if (event.code === 'Space' || event.code === 'Tab'
      || event.code === 'AltLeft' || event.code === 'AltRight') {
      event.preventDefault();
    }
  }

  // Release every held key, the trigger, the aim and any pending look delta. Used
  // whenever input can no longer be trusted: window blur, pointer-lock loss.
  function releaseAll() {
    keys.clear();
    pressed.clear();
    state.firing = false;
    state.aiming = false;
    state.lookX = 0;
    state.lookY = 0;
  }

  window.addEventListener('keydown', (event) => {
    setKey(event, true);
    // Minimap zoom is handled here, not by the sim: the sim never queries
    // KeyN, so the press would sit in the queue forever if left alone.
    if (event.code === 'KeyN' && !event.repeat) {
      pressed.delete('KeyN');
      toggleMinimapZoom();
    }
  });
  window.addEventListener('keyup', (event) => setKey(event, false));
  window.addEventListener('blur', () => releaseAll());
  window.addEventListener('mousemove', (event) => {
    if (!state.locked) return;
    noteActivity();
    state.lookX += event.movementX;
    state.lookY += event.movementY;
  });
  window.addEventListener('mousedown', (event) => {
    if (state.locked && event.button === 0) {
      noteActivity();
      state.firing = true;
    }
    if (state.locked && event.button === 2) {
      noteActivity();
      state.aiming = true;
    }
  });
  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) state.firing = false;
    if (event.button === 2) state.aiming = false;
  });
  document.addEventListener('pointerlockchange', () => {
    state.locked = document.pointerLockElement === canvas;
    if (!state.locked) releaseAll();
    onLockChange(state.locked);
  });
  // A failed lock request (browser denial, iframe permissions) used to fail
  // silently; surface it so the menu can tell the player to click again.
  document.addEventListener('pointerlockerror', () => {
    state.locked = false;
    onLockChange(false);
  });
  // Losing the window while firing must not leave the trigger stuck.
  window.addEventListener('contextmenu', (event) => event.preventDefault());

  // The minimap lives at top-left in the HUD. Zooming scales it 1.75x from
  // its top-left corner so it grows down-right over the yard, with an amber
  // outline so the player can tell at a glance that zoom is on. The rule is
  // injected once, on first use, so this module owns the feature end to end.
  let minimapStyleDone = false;
  function ensureMinimapStyle() {
    if (minimapStyleDone) return;
    minimapStyleDone = true;
    if (document.getElementById('dustline-minimap-style')) return;
    const style = document.createElement('style');
    style.id = 'dustline-minimap-style';
    style.textContent = [
      '#minimap.dustline-minimap-zoomed {',
      '  transform: scale(1.75);',
      '  transform-origin: top left;',
      '  z-index: 40;',
      '  box-shadow: 0 0 0 2px rgba(240, 168, 48, .9), 0 6px 22px rgba(0, 0, 0, .55);',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function toggleMinimapZoom() {
    ensureMinimapStyle();
    const el = document.getElementById('minimap');
    if (!el) return state.minimapZoomed;
    state.minimapZoomed = !state.minimapZoomed;
    el.classList.toggle('dustline-minimap-zoomed', state.minimapZoomed);
    return state.minimapZoomed;
  }

  return {
    state,
    requestLock() {
      canvas.requestPointerLock();
    },
    exitLock() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    takeLook() {
      const x = state.lookX;
      const y = state.lookY;
      state.lookX = 0;
      state.lookY = 0;
      return { x, y };
    },
    // Returns true once per physical key press; the sim consumes it in its step.
    wasPressed(code) {
      if (pressed.has(code)) { pressed.delete(code); return true; }
      return false;
    },
    clearPressed() { pressed.clear(); },
    // Is this code held right now? Reads through the same override the sim
    // sees, so isDown('ControlLeft') is true while walking with Alt held.
    isDown(code) { return keys.has(code); },
    // True if any of the given codes is held.
    anyDown(...codes) { return codes.some((code) => keys.has(code)); },
    // The speed factor the walk modifier applies: 0.55 while Alt is held,
    // 1 otherwise. Mirrors the factor the sim's slow-move path uses.
    walkScale() { return keys.walkHeld ? WALK_SPEED_FACTOR : 1; },
    // Flip the minimap zoom (same action as tapping N). Returns the new state.
    toggleMinimapZoom,
    // Seconds since the last key or mouse activity.
    idleSeconds() {
      if (!state.lastInputAt) return 0;
      return (performance.now() - state.lastInputAt) / 1000;
    },
    releaseAll,
  };
}
