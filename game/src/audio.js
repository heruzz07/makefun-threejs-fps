// All sound is synthesized with WebAudio: no audio files, no network. The context
// is created lazily on the first user gesture (browsers block audio before that).
//
// Two rng streams live here, and they must never be confused:
// - The SIM rng (mulberry32, seeded) drives gameplay and is never touched here.
// - A private AMBIENT rng (mulberry32 seeded from the clock) drives sound-only
//   variation: wind gusts and footstep surfaces. It changes nothing on screen,
//   so the deterministic ?shot= states are unaffected by it.
//
// Sound design notes (all values tuned by ear in headless playback):
// - Master gain 0.5; the wind bed sits at 0.035 so it reads as air, not hiss.
// - Weapon reports are a noise burst (the crack) plus a low tone (the body).
// - UI beeps are short sines; the plant/defuse channel beeps in a rising pair
//   so the player hears progress, not just a metronome.
// - The grenade throw has a falling whistle under the toss noise — a cue that
//   something is arcing through the air.
// - The round start opens with the two-note call and closes with a short
//   three-note sting, so the start of a round is unmistakable.
import { mulberry32, weightedPick } from './random.js';

export function createAudio() {
  let ctx = null;
  let master = null;
  let windGain = null;
  let muted = false;
  let noiseBuf = null;

  // Sound-only variation. Seeded from the clock: two runs never gust alike,
  // and that is fine — no gameplay value is ever drawn from this stream.
  const ambientRng = mulberry32((Date.now() & 0x7fffffff) | 1);

  // Wind-gust profiles: [name, weight, targetGain, rampSeconds]. The scheduler
  // picks one with weightedPick() every few seconds and eases the wind bed to
  // its level, so the yard breathes instead of humming at one flat level.
  const GUSTS = [
    { value: { level: 0.02, ramp: 1.6 }, weight: 5 }, // calm lull
    { value: { level: 0.05, ramp: 1.1 }, weight: 3 }, // passing gust
    { value: { level: 0.085, ramp: 0.7 }, weight: 1 }, // hard howl
  ];

  // Footstep surfaces under the player: [name, weight, filterFreq, gain].
  // Gravel crunches bright, sand is soft and low, metal pings rarely — the
  // yard is mostly packed sand with gravel patches and the odd panel frame.
  const STEPS = [
    { value: { freq: 600, gain: 0.05 }, weight: 6 }, // sand
    { value: { freq: 1100, gain: 0.06 }, weight: 3 }, // gravel
    { value: { freq: 2400, gain: 0.04 }, weight: 1 }, // metal panel
  ];

  function ensure() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
      // 1s of white noise, reused by every noise-based sound.
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
      startWind();
      scheduleGust();
      return true;
    } catch (e) {
      return false;
    }
  }

  // The wind bed: looped noise through a lowpass, quiet enough to sit under
  // everything else. scheduleGust() rides its level up and down.
  function startWind() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 320;
    windGain = ctx.createGain();
    windGain.gain.value = 0.035;
    src.connect(filt);
    filt.connect(windGain);
    windGain.connect(master);
    src.start();
  }

  // Pick a gust profile and ease the wind bed to it, then re-arm after a
  // short pause. Self-perpetuating until the page goes away; every call is
  // guarded so a torn-down context cannot throw.
  function scheduleGust() {
    if (!ctx || !windGain) return;
    const gust = weightedPick(ambientRng, GUSTS);
    const t = ctx.currentTime;
    windGain.gain.cancelScheduledValues(t);
    windGain.gain.setValueAtTime(windGain.gain.value, t);
    windGain.gain.linearRampToValueAtTime(gust.level, t + gust.ramp);
    const pauseMs = 2600 + ambientRng() * 5200;
    setTimeout(() => {
      if (!ctx || !windGain) return;
      const t2 = ctx.currentTime;
      windGain.gain.cancelScheduledValues(t2);
      windGain.gain.setValueAtTime(windGain.gain.value, t2);
      windGain.gain.linearRampToValueAtTime(0.035, t2 + 1.4);
      setTimeout(scheduleGust, 1200 + ambientRng() * 2400);
    }, pauseMs);
  }

  // Fire fn after ms, but only while the context is alive. Centralises the
  // guard so every delayed beep is safe if the tab is backgrounded.
  function after(ms, fn) {
    setTimeout(() => { if (ctx) fn(); }, ms);
  }

  function noiseBurst(dur, filterFreq, gainVal, type = 'lowpass') {
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  function tone(freq, dur, gainVal, type = 'sine', slideTo = 0) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // A tone whose pitch glides from one frequency to another — the grenade
  // whistle (falling) and, in principle, any rising/falling cue. The glide
  // is exponential so it reads as a smooth slide rather than a stepped one.
  function sweep(fromFreq, toFreq, dur, gainVal, type = 'sine') {
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, fromFreq), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, toFreq), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gainVal, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // freqs: array of [freq, startOffset, dur]
  function stinger(freqs, gainVal = 0.16) {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (const [freq, off, dur] of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0 + off);
      g.gain.exponentialRampToValueAtTime(gainVal, t0 + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + off + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0 + off);
      osc.stop(t0 + off + dur + 0.02);
    }
  }

  // Two quick beeps, the second a fourth higher: the plant channel ticking
  // upward as the spike arms. Called twice a second by the sim while planting.
  function channelBeep(baseFreq, secondFreq, dur = 0.08, gainVal = 0.14) {
    tone(baseFreq, dur, gainVal, 'sine');
    after(90, () => tone(secondFreq, dur, gainVal * 0.85, 'sine'));
  }

  return {
    ensure,
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.5;
      return muted;
    },
    shot(id) {
      if (!ctx) return;
      if (id === 'longbow') { noiseBurst(0.28, 900, 0.5); tone(140, 0.22, 0.3, 'sawtooth', 55); }
      else if (id === 'breacher') { noiseBurst(0.22, 1400, 0.5); tone(110, 0.16, 0.3, 'square', 60); }
      else if (id === 'raptor') { noiseBurst(0.09, 2400, 0.32); tone(220, 0.07, 0.16, 'square', 120); }
      else if (id === 'vk7') { noiseBurst(0.13, 1800, 0.4); tone(180, 0.1, 0.2, 'square', 90); }
      else { noiseBurst(0.08, 2800, 0.3); tone(260, 0.06, 0.14, 'square', 140); }
    },
    dryFire() { tone(900, 0.04, 0.12, 'square'); },
    reload() {
      tone(1400, 0.03, 0.1, 'square');
      after(260, () => tone(1000, 0.03, 0.1, 'square'));
      after(520, () => tone(1700, 0.04, 0.12, 'square'));
    },
    hit(kill) {
      tone(kill ? 1900 : 1250, kill ? 0.12 : 0.06, 0.18, 'sine');
      if (kill) after(70, () => tone(2400, 0.1, 0.14, 'sine'));
    },
    hurt() { tone(160, 0.18, 0.25, 'sawtooth', 70); noiseBurst(0.12, 500, 0.2); },
    // Footsteps vary by surface: the ambient rng picks sand, gravel or metal
    // on every step so the walk never sounds like a looped sample.
    step() {
      const surface = weightedPick(ambientRng, STEPS);
      noiseBurst(0.05, surface.freq, surface.gain);
    },
    // Plant channel: rising pair, 880 Hz then 1174 Hz (a fourth up).
    plantBeep() { channelBeep(880, 1174, 0.09, 0.14); },
    plantDone() { tone(660, 0.12, 0.16, 'sine'); after(120, () => tone(990, 0.18, 0.16, 'sine')); },
    // Defuse channel: faster, higher pair — 1180 Hz then 1568 Hz — so a
    // defuse sounds urgent where a plant sounds deliberate.
    defuseBeep() { channelBeep(1180, 1568, 0.07, 0.12); },
    spikeBeep() { tone(1500, 0.05, 0.1, 'square'); },
    explode() {
      noiseBurst(0.9, 300, 0.7);
      tone(60, 0.8, 0.5, 'sine', 30);
    },
    // Toss noise plus a falling whistle (1600 Hz down to 480 Hz) so the
    // grenade reads as something arcing away, not just a hand wave.
    grenadeThrow() {
      noiseBurst(0.1, 1200, 0.15);
      sweep(1600, 480, 0.45, 0.09, 'sine');
    },
    win() { stinger([[523, 0, 0.22], [659, 0.12, 0.22], [784, 0.24, 0.4]]); },
    lose() { stinger([[392, 0, 0.25], [330, 0.14, 0.25], [262, 0.28, 0.45]], 0.14); },
    buy() { tone(1050, 0.05, 0.12, 'sine'); after(60, () => tone(1400, 0.06, 0.12, 'sine')); },
    // Round start: the two-note call, then a short rising three-note sting
    // (523 / 659 / 784 Hz) so the round opening lands with intent.
    roundStart() {
      tone(440, 0.1, 0.14, 'triangle');
      after(110, () => tone(660, 0.16, 0.14, 'triangle'));
      after(240, () => stinger([[523, 0, 0.14], [659, 0.1, 0.14], [784, 0.2, 0.26]], 0.12));
    },
  };
}
