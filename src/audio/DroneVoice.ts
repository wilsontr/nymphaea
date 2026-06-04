import {
  AudioContext,
  OscillatorNode,
  GainNode,
  BiquadFilterNode,
  WaveShaperNode,
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
