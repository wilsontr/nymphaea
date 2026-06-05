import { AudioContext, WorkletProcessingNode } from "react-native-audio-api";

const REF_SR = 29761;

function sc(samples: number, sampleRate: number): number {
  return Math.max(1, Math.floor((samples * sampleRate) / REF_SR));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function mapNormalized(value: number, min: number, max: number): number {
  return min + value * (max - min);
}

type DelaySpec = {
  ap1: number;
  ap2: number;
  ap3: number;
  ap4: number;
  apModL: number;
  dL1: number;
  apL2: number;
  dL2: number;
  apModR: number;
  dR1: number;
  apR2: number;
  dR2: number;
  excursion: number;
};

export type DattorroReverbSettings = {
  decay: number;
  damping: number;
  bandwidth: number;
  diffusion: number;
  wetDry: number;
  preDelayMs: number;
  inputGain: number;
};

export class DattorroReverbNode {
  readonly node: WorkletProcessingNode;

  /**
   * Parameter slots (shared with the audio runtime callback):
   * 0 = decay      [0..1]
   * 1 = damping    [0..0.9999]
   * 2 = bandwidth  [0..0.99999]
   * 3 = diffusion  [0..1]
   * 4 = wetDry     [0..1]
   * 5 = preDelayMs [0..80]
  * 6 = inputGain  [0..1.5]
   */
  private readonly params = new Float32Array(7);

  constructor(
    ctx: AudioContext,
    initialSettings?: Partial<DattorroReverbSettings>,
  ) {
    // Set defaults before creating the worklet so they are captured correctly.
    this.setDecay(0.5);
    this.setDamping(0.0);
    this.setBandwidth(1.0);
    this.setDiffusion(1.0);
    this.setWetDry(0.33);
    this.setPreDelayMs(0.0);
    this.setInputGain(0.25);

    if (initialSettings) {
      if (initialSettings.decay !== undefined) this.setDecay(initialSettings.decay);
      if (initialSettings.damping !== undefined) this.setDamping(initialSettings.damping);
      if (initialSettings.bandwidth !== undefined) this.setBandwidth(initialSettings.bandwidth);
      if (initialSettings.diffusion !== undefined) this.setDiffusion(initialSettings.diffusion);
      if (initialSettings.wetDry !== undefined) this.setWetDry(initialSettings.wetDry);
      if (initialSettings.preDelayMs !== undefined) this.setPreDelayMs(initialSettings.preDelayMs);
      if (initialSettings.inputGain !== undefined) this.setInputGain(initialSettings.inputGain);
    }

    const sampleRate = Math.round(
      (ctx as unknown as { sampleRate?: number }).sampleRate ?? 48000,
    );
    const spec: DelaySpec = {
      ap1: sc(142, sampleRate),
      ap2: sc(107, sampleRate),
      ap3: sc(379, sampleRate),
      ap4: sc(277, sampleRate),
      apModL: sc(672, sampleRate),
      dL1: sc(4453, sampleRate),
      apL2: sc(1800, sampleRate),
      dL2: sc(3720, sampleRate),
      apModR: sc(908, sampleRate),
      dR1: sc(4217, sampleRate),
      apR2: sc(2656, sampleRate),
      dR2: sc(3163, sampleRate),
      excursion: sc(16, sampleRate),
    };

    const withHeadroom = (n: number) => n + 64;

    const tapL = {
      dR1a: sc(266, sampleRate),
      dR1b: sc(2974, sampleRate),
      apR2: sc(1913, sampleRate),
      dR2: sc(1996, sampleRate),
      dL1: sc(1990, sampleRate),
      apL2: sc(187, sampleRate),
      dL2: sc(1066, sampleRate),
    };

    const tapR = {
      dL1a: sc(353, sampleRate),
      dL1b: sc(3627, sampleRate),
      apL2: sc(1228, sampleRate),
      dL2: sc(2673, sampleRate),
      dR1: sc(2111, sampleRate),
      apR2: sc(335, sampleRate),
      dR2: sc(121, sampleRate),
    };

    const bufPredelay = new Float32Array(withHeadroom(sc(2976, sampleRate)));
    const bufAP1 = new Float32Array(withHeadroom(spec.ap1));
    const bufAP2 = new Float32Array(withHeadroom(spec.ap2));
    const bufAP3 = new Float32Array(withHeadroom(spec.ap3));
    const bufAP4 = new Float32Array(withHeadroom(spec.ap4));
    const bufAPModL = new Float32Array(withHeadroom(spec.apModL + spec.excursion));
    const bufDL1 = new Float32Array(withHeadroom(spec.dL1));
    const bufAPL2 = new Float32Array(withHeadroom(spec.apL2));
    const bufDL2 = new Float32Array(withHeadroom(spec.dL2));
    const bufAPModR = new Float32Array(withHeadroom(spec.apModR + spec.excursion));
    const bufDR1 = new Float32Array(withHeadroom(spec.dR1));
    const bufAPR2 = new Float32Array(withHeadroom(spec.apR2));
    const bufDR2 = new Float32Array(withHeadroom(spec.dR2));

    const heads = new Int32Array(13);
    const poleState = new Float32Array(3);
    const params = this.params;

    params[0] = this.params[0];
    params[1] = this.params[1];
    params[2] = this.params[2];
    params[3] = this.params[3];
    params[4] = this.params[4];
    params[5] = this.params[5];
    params[6] = this.params[6];

    const lfoPhase = new Float32Array(2);
    lfoPhase[1] = Math.PI / 2;

    this.node = ctx.createWorkletProcessingNode(
      (
        inputData: Float32Array[],
        outputData: Float32Array[],
        framesToProcess: number,
      ) => {
        "worklet";

        const inputL = inputData[0];
        const inputR = inputData[1];
        const outL = outputData[0];
        const outR = outputData[1] ?? outputData[0];

        if (!outL) {
          return;
        }

        const sr = sampleRate;
        const twoPi = Math.PI * 2;
        const lfoInc = (twoPi * 0.9) / sr;

        const decay = Math.max(0, Math.min(1, params[0]));
        const damping = Math.max(0, Math.min(0.9999, params[1]));
        const bandwidth = Math.max(0, Math.min(0.99999, params[2]));
        const diffusion = Math.max(0, Math.min(1, params[3]));
        const wetDry = Math.max(0, Math.min(1, params[4]));
        const preDelaySamples = Math.max(
          0,
          Math.min(bufPredelay.length - 2, Math.floor((params[5] * sr) / 1000)),
        );
        const inputGain = Math.max(0, Math.min(1.5, params[6]));

        // Diffusion drives allpass coefficients over a wider range for a clearer control feel.
        const g12 = 0.45 + diffusion * 0.35;
        const g34 = 0.3 + diffusion * 0.4;
        const gTankMod = -(0.55 + diffusion * 0.27);
        const gTank2 = 0.35 + diffusion * 0.27;
        const fbGain = 0.1 + decay * 0.85;

        const circRead = (buf: Float32Array, head: number, delayN: number): number => {
          "worklet";
          const N = buf.length;
          let pos = head - delayN;
          while (pos < 0) pos += N;
          while (pos >= N) pos -= N;
          return buf[pos];
        };

        const circReadFrac = (buf: Float32Array, head: number, delayN: number): number => {
          "worklet";
          const d0 = Math.floor(delayN);
          const frac = delayN - d0;
          const s0 = circRead(buf, head, d0);
          const s1 = circRead(buf, head, d0 + 1);
          return s0 + (s1 - s0) * frac;
        };

        const circWrite = (buf: Float32Array, head: number, value: number): number => {
          "worklet";
          buf[head] = value;
          const next = head + 1;
          return next >= buf.length ? 0 : next;
        };

        // Saturating nonlinearity to tame wet-output peaks.
        const softClip = (x: number): number => {
          "worklet";
          // Softer curve than x/(1+|x|) so saturation ramps in more gradually.
          return x / (1 + 0.25 * Math.abs(x));
        };

        for (let i = 0; i < framesToProcess; i++) {
          const dryL = inputL ? inputL[i] ?? 0 : 0;
          const dryR = inputR ? inputR[i] ?? dryL : dryL;
          const x = (dryL + dryR) * 0.5 * inputGain;

          heads[0] = circWrite(bufPredelay, heads[0], x);
          const predelayed =
            preDelaySamples > 0
              ? circRead(bufPredelay, heads[0], preDelaySamples)
              : x;

          // Bandwidth uses direct coefficient b: y = b*x + (1-b)*y[n-1].
          // With default b=0.9995 this should be near full-band input.
          const bwOut = bandwidth * predelayed + (1 - bandwidth) * poleState[0];
          poleState[0] = bwOut;

          let s = bwOut;

          {
            const v = circRead(bufAP1, heads[1], spec.ap1);
            const w = s - g12 * v;
            s = v + g12 * w;
            heads[1] = circWrite(bufAP1, heads[1], w);
          }
          {
            const v = circRead(bufAP2, heads[2], spec.ap2);
            const w = s - g12 * v;
            s = v + g12 * w;
            heads[2] = circWrite(bufAP2, heads[2], w);
          }
          {
            const v = circRead(bufAP3, heads[3], spec.ap3);
            const w = s - g34 * v;
            s = v + g34 * w;
            heads[3] = circWrite(bufAP3, heads[3], w);
          }
          {
            const v = circRead(bufAP4, heads[4], spec.ap4);
            const w = s - g34 * v;
            s = v + g34 * w;
            heads[4] = circWrite(bufAP4, heads[4], w);
          }

          const modL = Math.sin(lfoPhase[0]) * spec.excursion;
          const modR = Math.sin(lfoPhase[1]) * spec.excursion;
          lfoPhase[0] = (lfoPhase[0] + lfoInc) % twoPi;
          lfoPhase[1] = (lfoPhase[1] + lfoInc) % twoPi;

          const crossFromR = circRead(bufDR2, heads[12], spec.dR2);
          const leftIn = s + fbGain * crossFromR;
          const vModL = circReadFrac(bufAPModL, heads[5], spec.apModL + modL);
          const wModL = leftIn - gTankMod * vModL;
          const yModL = vModL + gTankMod * wModL;
          heads[5] = circWrite(bufAPModL, heads[5], wModL);

          heads[6] = circWrite(bufDL1, heads[6], yModL);
          let l = circRead(bufDL1, heads[6], spec.dL1);
          l = (1 - damping) * l + damping * poleState[1];
          poleState[1] = l;
          l *= fbGain;
          {
            const v = circRead(bufAPL2, heads[7], spec.apL2);
            const w = l - gTank2 * v;
            l = v + gTank2 * w;
            heads[7] = circWrite(bufAPL2, heads[7], w);
          }
          heads[8] = circWrite(bufDL2, heads[8], l);

          const crossFromL = circRead(bufDL2, heads[8], spec.dL2);
          const rightIn = s + fbGain * crossFromL;
          const vModR = circReadFrac(bufAPModR, heads[9], spec.apModR + modR);
          const wModR = rightIn - gTankMod * vModR;
          const yModR = vModR + gTankMod * wModR;
          heads[9] = circWrite(bufAPModR, heads[9], wModR);

          heads[10] = circWrite(bufDR1, heads[10], yModR);
          let r = circRead(bufDR1, heads[10], spec.dR1);
          r = (1 - damping) * r + damping * poleState[2];
          poleState[2] = r;
          r *= fbGain;
          {
            const v = circRead(bufAPR2, heads[11], spec.apR2);
            const w = r - gTank2 * v;
            r = v + gTank2 * w;
            heads[11] = circWrite(bufAPR2, heads[11], w);
          }
          heads[12] = circWrite(bufDR2, heads[12], r);

          const yL =
            +0.6 * circRead(bufDR1, heads[10], tapL.dR1a) +
            +0.6 * circRead(bufDR1, heads[10], tapL.dR1b) -
            0.6 * circRead(bufAPR2, heads[11], tapL.apR2) +
            +0.6 * circRead(bufDR2, heads[12], tapL.dR2) -
            0.6 * circRead(bufDL1, heads[6], tapL.dL1) -
            0.6 * circRead(bufAPL2, heads[7], tapL.apL2) -
            0.6 * circRead(bufDL2, heads[8], tapL.dL2);

          const yR =
            +0.6 * circRead(bufDL1, heads[6], tapR.dL1a) +
            +0.6 * circRead(bufDL1, heads[6], tapR.dL1b) -
            0.6 * circRead(bufAPL2, heads[7], tapR.apL2) +
            +0.6 * circRead(bufDL2, heads[8], tapR.dL2) -
            0.6 * circRead(bufDR1, heads[10], tapR.dR1) -
            0.6 * circRead(bufAPR2, heads[11], tapR.apR2) -
            0.6 * circRead(bufDR2, heads[12], tapR.dR2);

          const wetL = softClip(yL);
          const wetR = softClip(yR);
          const dryMix = 1 - wetDry;
          outL[i] = dryL * dryMix + wetL * wetDry;
          outR[i] = dryR * dryMix + wetR * wetDry;
        }
      },
      "AudioRuntime",
    );
  }

  /**
   * Decay controls feedback gain (tail length).
   * Input range: 0..1 mapped to useful range 0.1..0.98.
   * Audible change: low values give short room-like tails; high values give long sustaining tails.
   */
  setDecay(v: number): void {
    const normalized = clamp(finiteOr(v, 0.5), 0, 1);
    this.params[0] = mapNormalized(normalized, 0.1, 0.98);
  }

  /**
   * Damping controls high-frequency loss in the tank.
   * Input range: 0..1 mapped to useful range 0.0005..0.45.
   * Audible change: higher values remove highs faster and make the tail darker/shorter.
   */
  setDamping(v: number): void {
    const normalized = clamp(finiteOr(v, 0.0), 0, 1);
    this.params[1] = mapNormalized(normalized, 0.0005, 0.45);
  }

  /**
   * Bandwidth is the input low-pass direct coefficient b in y = b*x + (1-b)*y[n-1].
   * Input range: 0..1 mapped to useful range 0.35..0.9999.
   * Audible change: lower values darken input into the reverb; higher values keep the reverb bright.
   */
  setBandwidth(v: number): void {
    const normalized = clamp(finiteOr(v, 1.0), 0, 1);
    this.params[2] = mapNormalized(normalized, 0.35, 0.9999);
  }

  /**
   * Diffusion controls allpass coefficients and tail density.
   * Input range: 0..1 mapped to useful range 0..1.
   * Audible change: low values sound grainier/echo-like; high values sound smoother and denser.
   */
  setDiffusion(v: number): void {
    const normalized = clamp(finiteOr(v, 1.0), 0, 1);
    this.params[3] = normalized;
  }

  /**
   * Wet/dry mix where 0=dry only and 1=wet only.
   * Useful range: 0.15..0.6 for insert use; up to 1.0 for effect-only auditioning.
   * Audible change: higher values push the source back in space and make tails more obvious.
   */
  setWetDry(v: number): void {
    this.params[4] = clamp(finiteOr(v, 0.33), 0, 1);
  }

  /**
   * Pre-delay in milliseconds before tank input.
   * Useful range: 0..35 ms (up to 80 ms available).
   * Audible change: increasing pre-delay separates the dry attack from the reverb onset.
   */
  setPreDelayMs(v: number): void {
    this.params[5] = clamp(finiteOr(v, 0), 0, 80);
  }

  /**
   * Input gain before pre-delay and tank processing.
   * Input range: 0..1 mapped to useful range 0..1.5.
   * Audible change: higher values drive the tank harder, increasing density/level and potential saturation.
   */
  setInputGain(v: number): void {
    const normalized = clamp(finiteOr(v, 0.2), 0, 1);
    this.params[6] = mapNormalized(normalized, 0, 1.5);
  }

  dispose(): void {
    this.node.disconnect();
  }
}
