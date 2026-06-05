import {
  AudioContext,
  OscillatorNode,
  GainNode,
} from "react-native-audio-api";

/**
 * A single detuned oscillator voice in the drone bank.
 * Frequency is base * ratio. Each voice has an independent
 * slow oscillation on its detune (managed externally by AudioEngine).
 */
export class DroneVoice {
  readonly oscillator: OscillatorNode;
  readonly gainNode: GainNode;

  constructor(
    context: AudioContext,
    baseFrequency: number,
    ratio: number,
    type: OscillatorType = "sine",
  ) {
    this.oscillator = context.createOscillator();
    this.oscillator.type = type;
    this.oscillator.frequency.value = baseFrequency * ratio;

    this.gainNode = context.createGain();
    this.gainNode.gain.value = 0.18;

    this.oscillator.connect(this.gainNode);
  }

  start(): void {
    this.oscillator.start(0);
  }

  /** Start oscillator at an explicit time for smoother graph startup. */
  startAt(when: number): void {
    this.oscillator.start(when);
  }

  /** Fade this voice out quickly and stop its oscillator. */
  stop(currentTime: number, fadeTime = 0.04): void {
    try {
      this.gainNode.gain.cancelScheduledValues(currentTime);
      this.gainNode.gain.linearRampToValueAtTime(0, currentTime + fadeTime);
      this.oscillator.stop(currentTime + fadeTime + 0.01);
    } catch {
      // Oscillator can already be stopped during fast refresh teardown.
    }
  }

  /** Ramp frequency to a new value over `rampTime` seconds. */
  setFrequency(freq: number, currentTime: number, rampTime = 2): void {
    this.oscillator.frequency.linearRampToValueAtTime(
      freq,
      currentTime + rampTime,
    );
  }

  /** Ramp detune (in cents) to a new value over `rampTime` seconds. */
  setDetune(cents: number, currentTime: number, rampTime = 0.5): void {
    this.oscillator.detune.linearRampToValueAtTime(
      cents,
      currentTime + rampTime,
    );
  }
}
