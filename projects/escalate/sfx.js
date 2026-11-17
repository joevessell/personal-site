/*
 * Retro arcade sound effects, synthesized with the Web Audio API.
 * Square/triangle oscillators and a noise channel, like an 80s sound chip —
 * no audio files, nothing to license.
 *
 * Usage: SFX.play('coin'); SFX.enabled = false;
 */
(() => {
  'use strict';

  const STORE_KEY = 'ceralis-sound';
  const MASTER = 0.5;

  let ac = null;
  let master = null;
  let noiseBuf = null;

  function load() {
    try { return localStorage.getItem(STORE_KEY) !== 'off'; } catch { return true; }
  }
  let enabled = load();

  /** Create the audio graph lazily — browsers only allow it after a user gesture. */
  function ctx() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = MASTER;
      master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  /** One oscillator note, optionally sliding from `freq` to `to`. */
  function tone(t0, { freq, to = freq, dur = 0.1, type = 'square', vol = 0.15, at = 0 }) {
    const t = t0 + at;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.setValueAtTime(vol, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A burst of filtered noise (explosions, crunches). */
  function noise(t0, { dur = 0.3, vol = 0.2, at = 0, cutoff = 1200 }) {
    const t = t0 + at;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    f.frequency.exponentialRampToValueAtTime(80, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur);
  }

  const pick = a => a[Math.floor(Math.random() * a.length)];
  const PENTA = [523, 587, 659, 784, 880, 1047, 1175, 1319];

  const SOUNDS = {
    // UI
    click: t => tone(t, { freq: 880, dur: 0.04, vol: 0.08 }),
    tick: t => tone(t, { freq: 1400, dur: 0.015, type: 'triangle', vol: 0.05 }),
    toggle: t => { tone(t, { freq: 660, dur: 0.04, vol: 0.08 }); tone(t, { freq: 990, dur: 0.05, vol: 0.08, at: 0.045 }); },
    coin: t => { tone(t, { freq: 988, dur: 0.08 }); tone(t, { freq: 1319, dur: 0.35, at: 0.08 }); },
    random: t => {
      for (let i = 0; i < 7; i++) {
        tone(t, { freq: PENTA[Math.floor(Math.random() * PENTA.length)], dur: 0.04, vol: 0.1, at: i * 0.04 });
      }
    },

    // Game flow
    launch: t => tone(t, { freq: 440, to: 660, dur: 0.12, type: 'triangle', vol: 0.2 }),
    // Ambient activity (quiet; `v` 0..1 scales with how busy the planet is)
    'boop-birth': (t, v) => tone(t, { freq: pick([784, 880, 1047, 1175]), dur: 0.05, type: 'triangle', vol: 0.05 * v }),
    'boop-eat': (t, v) => tone(t, { freq: pick([392, 440, 523]), to: 330, dur: 0.06, type: 'triangle', vol: 0.06 * v }),
    'boop-starve': (t, v) => tone(t, { freq: 262, to: 196, dur: 0.08, type: 'triangle', vol: 0.05 * v }),
    retry: t => tone(t, { freq: 440, to: 660, dur: 0.12, type: 'triangle', vol: 0.2 }),
    reset: t => tone(t, { freq: 660, to: 220, dur: 0.15, vol: 0.1 }),
    pause: t => { tone(t, { freq: 784, dur: 0.07, vol: 0.1 }); tone(t, { freq: 523, dur: 0.1, vol: 0.1, at: 0.08 }); },
    resume: t => { tone(t, { freq: 523, dur: 0.07, vol: 0.1 }); tone(t, { freq: 784, dur: 0.1, vol: 0.1, at: 0.08 }); },
    goal: t => {
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(t, { freq: f, dur: 0.09, at: i * 0.09 }));
      tone(t, { freq: 1319, dur: 0.45, at: 0.54 });
      tone(t, { freq: 262, dur: 0.9, type: 'triangle', vol: 0.15 });
    },
    gameover: t => tone(t, { freq: 330, to: 220, dur: 0.18, type: 'triangle', vol: 0.2 }),
  };

  // Rapid-fire sounds (slider ticks) are rate-limited so they don't buzz.
  const MIN_GAP = { tick: 0.045 };
  const lastPlayed = {};

  function play(name, v = 1) {
    if (!enabled || !SOUNDS[name]) return;
    const a = ctx();
    if (!a) return;
    const t = a.currentTime;
    if (MIN_GAP[name] && t - (lastPlayed[name] ?? -1) < MIN_GAP[name]) return;
    lastPlayed[name] = t;
    SOUNDS[name](t + 0.01, v);
  }

  window.SFX = {
    play,
    get enabled() { return enabled; },
    set enabled(v) {
      enabled = !!v;
      try { localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off'); } catch { /* storage unavailable */ }
    },
  };
})();
