import {
  AudioContext,
  GainNode,
  BiquadFilterNode,
  WaveShaperNode,
} from "react-native-audio-api";
import { DroneVoice } from "./DroneVoice";
import { DattorroReverbNode } from "./DattorroReverbNode";

const BASE_FREQ = 110; // A2

/**
 * Drone voice ratios:
 *   Voice 0 – root (1.00)
 *   Voice 1 – perfect fifth (1.50)
 *   Voice 2 – suboctave (0.50)
 *   Voice 3 – minor/major third (mood-interpolated, rebuilt on mood change)
 *   Voice 4 – overtone with texture influence (3.00)
 */
const RATIOS: [number, OscillatorType][] = [
  [1.0, "sine"],
  [1.505, "sine"],
  [0.5006, "sawtooth"],
  [1.2, "sawtooth"], // minor third ≈ 1.189; will be updated by mood
  [3.507, "sine"],
  [4.0, "triangle"],
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
  private reverb: DattorroReverbNode | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private startupPhaseUntil = 0;

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
    const t0 = ctx.currentTime;
    this.startupPhaseUntil = t0 + 1.5;

    // --- Build audio graph ---
    // Voices → WaveShaper → Filter → DattorroReverb → MasterGain → destination
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0.0; // fade in on start

    this.filter = ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = this._filterCutoff(
      this.mood,
      this.brightness,
    );
    this.filter.Q.value = this._filterResonance(this.texture);

    this.waveShaper = ctx.createWaveShaper();
    this.waveShaper.curve = makeSoftClipCurve();
    this.waveShaper.oversample = "4x";

    this.reverb = new DattorroReverbNode(ctx, {
      bandwidth: 0.8,
      decay: 0.95,
      damping: 0.2,
      diffusion: 0.8,
      wetDry: 0.95,
      preDelayMs: 80,
      inputGain: 0.3,
    });

    // Create voices and connect them to the waveShaper
    for (let i = 0; i < RATIOS.length; i++) {
      const [ratio, type] = RATIOS[i];
      const tunedRatio = i === 3 ? 1.189 + this.mood * (1.26 - 1.189) : ratio;
      const voice = new DroneVoice(ctx, BASE_FREQ, ratio, type);
      voice.setDetune(0, t0, 0.01);
      voice.setFrequency(BASE_FREQ * tunedRatio, t0, 0.01);
      voice.gainNode.connect(this.waveShaper);
      this.voices.push(voice);
    }

    this.waveShaper.connect(this.filter);
    this.filter.connect(this.reverb.node);
    this.reverb.node.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // Start all oscillators
    for (const voice of this.voices) {
      voice.startAt(t0 + 0.03);
    }

    // // Give the graph a moment to settle, then fade in.
    this.masterGain.gain.linearRampToValueAtTime(0, t0);
    this.masterGain.gain.cancelScheduledValues(t0);
    this.masterGain.gain.linearRampToValueAtTime(1.0, t0 + 5);

    // Start slow drift timer for individual voice detuning
    this.driftTimer = setInterval(() => this._driftVoices(), 80);
  }

  stop(): void {
    if (this.driftTimer) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
    if (this.context) {
      const t = this.context.currentTime;

      // Fade-out quickly to suppress teardown chirps on fast reload.
      if (this.masterGain) {
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.linearRampToValueAtTime(0, t + 0.04);
      }

      for (const voice of this.voices) {
        voice.stop(t, 0.04);
      }

      this.waveShaper?.disconnect();
      this.filter?.disconnect();
      this.reverb?.dispose();
      this.masterGain?.disconnect();

      this.context.close();
      this.context = null;
    }
    this.voices = [];
    this.filter = null;
    this.masterGain = null;
    this.waveShaper = null;
    this.reverb = null;
  }

  // --- Parameter setters 

  setMood(value: number): void {
    this.mood = value;
    if (!this.context || !this.filter) return;
    const t = this.context.currentTime;
    this.filter.frequency.linearRampToValueAtTime(
      this._filterCutoff(value, this.brightness),
      t + 0.5,
    );
    // this.reverb?.setDecay(0.25 + value * 0.75);
    // this.reverb?.setWetDry(0.2 + value * 0.45);

    // Voice 3: interpolate between minor third (1.189) and major third (1.260)
    const thirdRatio = 1.189 + value * (1.26 - 1.189);
    const v = this.voices[3];
    if (v) {
      const ramp = t < this.startupPhaseUntil ? 0.02 : 2;
      v.setFrequency(BASE_FREQ * thirdRatio, t, ramp);
    }
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
    // this.masterGain.gain.linearRampToValueAtTime(gainTarget, t + 1.0);

    // Lower brightness darkens the tail with stronger damping.
    // this.reverb?.setDamping(0.001 + (1 - value) * 0.08);
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

    // Higher texture increases diffusion and subtle pre-delay spread.
    // this.reverb?.setDiffusion(0.5 + value * 0.5);
    // this.reverb?.setPreDelayMs(value * 30);
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

    // this.reverb?.setWetDry(0.15 + value * 0.55);
    // this.reverb?.setWetDry(0.9);
  }

  // --- Internal helpers ---

  private _filterCutoff(mood: number, brightness: number): number {
    // mood 0–1: 200–1200 Hz base; brightness 0–1: additional 0–2000 Hz boost
    return 100 + mood * 1200 + brightness * 2200;
  }

  private _filterResonance(texture: number): number {
    // texture 0–1: Q from 1.0 to 4.0
    return 1.0 + texture * 3.0;
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
