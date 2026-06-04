import {
  AudioContext,
  GainNode,
  BiquadFilterNode,
  WaveShaperNode,
} from "react-native-audio-api";
import { DroneVoice } from "./DroneVoice";

const BASE_FREQ = 110; // A2

/**
 * Drone voice ratios:
 *   Voice 0 – root (1.00)
 *   Voice 1 – perfect fifth (1.50)
 *   Voice 2 – octave (2.00)
 *   Voice 3 – minor/major third (mood-interpolated, rebuilt on mood change)
 *   Voice 4 – overtone with texture influence (3.00)
 */
const RATIOS: [number, OscillatorType][] = [
  [1.0, "sine"],
  [1.5, "sine"],
  [2.0, "sine"],
  [1.2, "triangle"], // minor third ≈ 1.189; will be updated by mood
  [3.0, "sawtooth"],
];

/** Build a soft-clip waveshaper curve (tanh approximation). */
function makeSoftClipCurve(samples = 256): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * 1.5);
  }
  return curve;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private voices: DroneVoice[] = [];
  private filter: BiquadFilterNode | null = null;
  private masterGain: GainNode | null = null;
  private waveShaper: WaveShaperNode | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;

  // Current param values (updated from the outside)
  private mood = 0.3;
  private brightness = 0.6;
  private speed = 0.4;
  private texture = 0.3;
  private density = 0.5;

  start(): void {
    if (this.context) return;

    this.context = new AudioContext();
    const ctx = this.context;

    // --- Build audio graph ---
    // Voices → WaveShaper → Filter → MasterGain → destination
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.0; // fade in on start

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = this._filterCutoff(
      this.mood,
      this.brightness,
    );
    this.filter.Q.value = 1.2;

    this.waveShaper = ctx.createWaveShaper();
    this.waveShaper.curve = makeSoftClipCurve();
    this.waveShaper.oversample = "4x";

    // Create voices and connect them to the waveShaper
    for (const [ratio, type] of RATIOS) {
      const voice = new DroneVoice(ctx, BASE_FREQ, ratio, type);
      voice.gainNode.connect(this.waveShaper);
      this.voices.push(voice);
    }

    this.waveShaper.connect(this.filter);
    this.filter.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // Start all oscillators
    for (const voice of this.voices) {
      voice.start();
    }

    // Fade in master gain over 2 seconds
    this.masterGain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 2);

    // Start slow drift timer for individual voice detuning
    this.driftTimer = setInterval(() => this._driftVoices(), 80);
  }

  stop(): void {
    if (this.driftTimer) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
    if (this.context) {
      this.context.close();
      this.context = null;
    }
    this.voices = [];
    this.filter = null;
    this.masterGain = null;
    this.waveShaper = null;
  }

  // --- Parameter setters (called from useAnimatedReaction via runOnJS) ---

  setMood(value: number): void {
    this.mood = value;
    if (!this.context || !this.filter) return;
    const t = this.context.currentTime;
    this.filter.frequency.linearRampToValueAtTime(
      this._filterCutoff(value, this.brightness),
      t + 0.5,
    );
    // Voice 3: interpolate between minor third (1.189) and major third (1.260)
    const thirdRatio = 1.189 + value * (1.26 - 1.189);
    const v = this.voices[3];
    if (v) v.setFrequency(BASE_FREQ * thirdRatio, t);
  }

  setBrightness(value: number): void {
    this.brightness = value;
    if (!this.context || !this.filter || !this.masterGain) return;
    const t = this.context.currentTime;
    this.filter.frequency.linearRampToValueAtTime(
      this._filterCutoff(this.mood, value),
      t + 0.5,
    );
    // Brightness also nudges master gain (louder = brighter)
    const gainTarget = 0.4 + value * 0.35;
    this.masterGain.gain.linearRampToValueAtTime(gainTarget, t + 1.0);
  }

  setTexture(value: number): void {
    this.texture = value;
    if (!this.context || !this.filter) return;
    // Higher texture → raise resonance for a grittier tone
    this.filter.Q.value = 1.0 + value * 3.0;
    // Voice 4 (overtone) gets louder with texture
    const v = this.voices[4];
    if (v) {
      v.gainNode.gain.linearRampToValueAtTime(
        0.05 + value * 0.18,
        this.context.currentTime + 0.5,
      );
    }
  }

  setSpeed(value: number): void {
    this.speed = value;
  }

  setDensity(value: number): void {
    this.density = value;
    if (!this.context) return;
    // Density scales the overall voice gain mix
    const gainScale = 0.3 + value * 0.4;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const baseGain = i < 3 ? 0.18 : 0.08;
      v.gainNode.gain.linearRampToValueAtTime(
        baseGain * gainScale,
        this.context.currentTime + 1.0,
      );
    }
  }

  // --- Internal helpers ---

  private _filterCutoff(mood: number, brightness: number): number {
    // mood 0–1: 200–1200 Hz base; brightness 0–1: additional 0–2000 Hz boost
    return 200 + mood * 1000 + brightness * 2000;
  }

  private _driftVoices(): void {
    if (!this.context) return;
    const t = this.context.currentTime;
    const speedFactor = 0.2 + this.speed * 1.8;
    const baseDetune = this.texture * 15;

    for (let i = 0; i < this.voices.length; i++) {
      // Independent random detune walk per voice
      const cents = (Math.random() - 0.5) * baseDetune * 2;
      this.voices[i].setDetune(cents, t, 0.8 / speedFactor);
    }
  }
}
