// All sound is synthesized with WebAudio: no audio files, no network. The context is
// created lazily on the first user gesture (browsers block audio before that).
export function createAudio() {
  let ctx = null;
  let master = null;
  let windGain = null;
  let muted = false;
  let noiseBuf = null;

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
      return true;
    } catch (e) {
      return false;
    }
  }

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
      setTimeout(() => tone(1000, 0.03, 0.1, 'square'), 260);
      setTimeout(() => tone(1700, 0.04, 0.12, 'square'), 520);
    },
    hit(kill) {
      tone(kill ? 1900 : 1250, kill ? 0.12 : 0.06, 0.18, 'sine');
      if (kill) setTimeout(() => tone(2400, 0.1, 0.14, 'sine'), 70);
    },
    hurt() { tone(160, 0.18, 0.25, 'sawtooth', 70); noiseBurst(0.12, 500, 0.2); },
    step() { noiseBurst(0.05, 700, 0.05); },
    plantBeep() { tone(880, 0.09, 0.14, 'sine'); },
    plantDone() { tone(660, 0.12, 0.16, 'sine'); setTimeout(() => tone(990, 0.18, 0.16, 'sine'), 120); },
    defuseBeep() { tone(1180, 0.07, 0.12, 'sine'); },
    spikeBeep() { tone(1500, 0.05, 0.1, 'square'); },
    explode() {
      noiseBurst(0.9, 300, 0.7);
      tone(60, 0.8, 0.5, 'sine', 30);
    },
    grenadeThrow() { noiseBurst(0.1, 1200, 0.15); },
    win() { stinger([[523, 0, 0.22], [659, 0.12, 0.22], [784, 0.24, 0.4]]); },
    lose() { stinger([[392, 0, 0.25], [330, 0.14, 0.25], [262, 0.28, 0.45]], 0.14); },
    buy() { tone(1050, 0.05, 0.12, 'sine'); setTimeout(() => tone(1400, 0.06, 0.12, 'sine'), 60); },
    roundStart() { tone(440, 0.1, 0.14, 'triangle'); setTimeout(() => tone(660, 0.16, 0.14, 'triangle'), 110); },
  };
}
