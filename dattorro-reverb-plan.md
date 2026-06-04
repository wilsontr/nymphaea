# Dattorro Plate Reverb — Implementation Plan

This document covers four implementation paths in increasing order of quality and
native depth, plus the app architecture changes needed to support any of them:

1. What the Dattorro algorithm is and how it maps to audio graph primitives
2. A graph-based implementation using `react-native-audio-api` nodes
3. A `WorkletProcessingNode`-based implementation for lower overhead
4. **A C++ TurboModule implementation — the optimal target**
5. The app architecture changes needed to support any path

---

## The algorithm

Dattorro's plate reverb (JAES, 1997) consists of two stages:

```
xL ─┐
    ├─ ×½ ─→ predelay ─→ BW filter ─→ AP1 ─→ AP2 ─→ AP3 ─→ AP4 ─→ ─┐
xR ─┘                                                                  │
                                                                       ↓ (tank input)
         ┌──────────────────── left feedback loop ────────────────────────────────┐
         │                                                                        │
         │   mod AP L(−0.70) ─→ delay L1 ─→ 1-pole damp L ─→ ×decay ─→ AP L2(0.50) ─→ delay L2 ─┐
         │                                                                                          │ (cross)
         └──────────────────────────────────────────────────────────────────────────────────────── ┘
         │
         │   mod AP R(−0.70) ─→ delay R1 ─→ 1-pole damp R ─→ ×decay ─→ AP R2(0.50) ─→ delay R2 ─┐
         │                                                                                          │ (cross)
         └──────────────────────────────────────────────────────────────────────────────────────── ┘
```

Output taps are taken from **specific sample offsets within** each tank delay line
(not end-of-line) and weighted by 0.6 to produce stereo wet signal. The two
loops cross-feed into each other forming the "figure-of-8".

### Canonical delay lengths

The paper's reference sample rate is 29761 Hz. Delay lengths are given as exact
sample counts at that rate. Scale to your target rate with `floor(n * SR / 29761)`.
At 48000 Hz the ms column gives the approximate delay time.

| Fig. 1 node | Stage                              | Samples @ 29761 | ms @ 48000 |
| ----------- | ---------------------------------- | --------------- | ---------- |
| 13–14       | Input AP 1 (g = +0.750)            | 142             | 4.77       |
| 19–20       | Input AP 2 (g = +0.750)            | 107             | 3.60       |
| 15–16       | Input AP 3 (g = +0.625)            | 379             | 12.73      |
| 21–22       | Input AP 4 (g = +0.625)            | 277             | 9.31       |
| 23–24       | Tank mod AP left (g = **−0.700**)  | 672             | 22.58      |
| 24–30       | Tank delay L1                      | 4453            | 149.6      |
| 30          | Tank damp L (1-pole IIR)           | —               | —          |
| 31–33       | Tank AP left 2 (g = **+0.500**)    | 1800            | 60.48      |
| 33–39       | Tank delay L2                      | 3720            | 124.9      |
| 46–48       | Tank mod AP right (g = **−0.700**) | 908             | 30.51      |
| 48–54       | Tank delay R1                      | 4217            | 141.7      |
| 54          | Tank damp R (1-pole IIR)           | —               | —          |
| 55–59       | Tank AP right 2 (g = **+0.500**)   | 2656            | 89.24      |
| 59–63       | Tank delay R2                      | 3163            | 106.3      |

Default parameter values from Table 1 of the paper:

- `decay` = 0.50 (rate of decay; also controls loop feedback gain)
- `decay diffusion 1` = 0.70 used as **negative** (sign noted in Fig. 1) — controls
  density of tail
- `decay diffusion 2` = 0.50 — decorrelates tank signals
- `input diffusion 1` = 0.750 (AP1, AP2)
- `input diffusion 2` = 0.625 (AP3, AP4)
- `bandwidth` = 0.9995 (first-order pre-filter coefficient)
- `damping` = 0.0005 (first-order in-tank filter coefficient; 0 = no damping)
- `EXCURSION` = 16 samples at 29761 Hz ≈ 26 samples at 48000 Hz

The modulated allpasses use **two LFOs running in quadrature at ~1 Hz** (the paper
says "on the order of 1 Hz"). EXCURSION is the ±peak sample deviation.

### Output taps (Table 2 of the paper)

All taps are multiplied by 0.6. Node names encode the containing delay line, e.g.
`node24_30[1990]` means read 1990 samples back from the current write position
in the tank delay L1 (nodes 24–30). Sample offsets given at 29761 Hz and must
be scaled to the target rate.

```
Left output (yL), all wet:
  +0.6 × node48_54[266]     (tank delay R1, offset 266)
  +0.6 × node48_54[2974]
  −0.6 × node55_59[1913]    (tank AP R2 delay)
  +0.6 × node59_63[1996]    (tank delay R2)
  −0.6 × node24_30[1990]    (tank delay L1)
  −0.6 × node31_33[187]     (tank AP L2 delay)
  −0.6 × node33_39[1066]    (tank delay L2)

Right output (yR), all wet:
  +0.6 × node24_30[353]
  +0.6 × node24_30[3627]
  −0.6 × node31_33[1228]
  +0.6 × node33_39[2673]
  −0.6 × node48_54[2111]
  −0.6 × node55_59[335]
  −0.6 × node59_63[121]
```

This means each of the four main tank delay lines is read at **2–3 different offsets**
for output purposes. In a graph-based implementation, each tap requires a
separate `DelayNode` set to the appropriate offset — adding ~14 nodes beyond the
structural graph. In the worklet, these are simply circular buffer reads.

---

## Primitive building block: the Schroeder allpass

Every allpass in the algorithm is a **Schroeder allpass** (two-multiplier lattice):

```
                     ┌────────────────────── GainNode(−g) ──────────────────┐
                     │                                                       │
input ─→ [summerA] ──┼──→ DelayNode(T) ──→ [summerB] ─→ output
                     │                          │
                     └── GainNode(+g) ←─────────┘
```

In Web Audio graph terms:

- `summerA` and `summerB` are implicit — any node accepts multiple `.connect()`
  calls and sums its inputs
- The feedback path `DelayNode → GainNode(−g) → summerA` creates the IIR loop
- The feedforward path `DelayNode → GainNode(+g) → summerB` creates the FIR part

Coefficient values (from Table 1):

- Input AP 1 & 2: g = +0.750
- Input AP 3 & 4: g = +0.625
- Tank mod AP left & right (decay diffusion 1): g = **−0.700** (negative — "note sign"
  in Fig. 1; this inverts the impulse response character and is deliberate)
- Tank AP left2 & right2 (decay diffusion 2): g = **+0.500**

### First-order single-pole IIR (bandwidth and damping)

The bandwidth pre-filter and both tank damping filters are **first-order single-pole
low-pass** of the form:

$$y[n] = (1 - k) \cdot x[n] + k \cdot y[n-1]$$

where k = bandwidth (0.9995) or k = damping (0.0005). This is **not** a
`BiquadFilterNode` (which is second-order). In the graph-based implementation
these must be built from a `DelayNode(1/SR)` and two `GainNode`s with a feedback
loop. In the worklet implementation they are a single multiply-accumulate per sample.

---

## Phase 1: graph-based implementation

### New file: `src/audio/Reverb.ts`

**Key design notes before reading the code:**

- Bandwidth and damping are **first-order single-pole IIR**, not biquad. Each is
  built from a `DelayNode(1 sample)` + two `GainNode`s in a feedback loop.
- The modulated tank allpasses use **g = −0.700** (negative). Pass a negative value.
- The unmodulated tank allpasses use **g = +0.500**, not 0.75.
- Output taps read at **intermediate offsets** inside each delay line, requiring a
  separate `DelayNode` per tap (7 per channel, 14 total). Each tap weight = 0.6.
- Input is stereo (xL + xR mixed at ×½) with an optional predelay before BW filter.
- LFOs run in quadrature (~1 Hz), excursion = `Math.round(16 * SR / 29761)` samples.

```typescript
import {
  AudioContext,
  GainNode,
  DelayNode,
  OscillatorNode,
} from "react-native-audio-api";

const REF_SR = 29761; // Dattorro's reference sample rate

/** Scale a sample count from the reference rate to the context sample rate */
function sc(samples: number, SR: number): number {
  return Math.floor((samples * SR) / REF_SR);
}

/** Convert sample count to seconds */
function st(samples: number, SR: number): number {
  return sc(samples, SR) / SR;
}

export class PlateReverb {
  readonly inputL: GainNode; // connect left channel here
  readonly inputR: GainNode; // connect right channel here
  readonly outputL: GainNode; // left wet output
  readonly outputR: GainNode; // right wet output

  private _decayGains: GainNode[] = [];
  private _dampCoeffs: GainNode[] = []; // (1 − damping) gain in the 1-pole IIR
  private _dampFeedb: GainNode[] = []; // damping gain (feedback coefficient)
  private _allpassFbk: GainNode[] = []; // allpass feedback gains (all 8)
  private _allpassFwd: GainNode[] = []; // allpass feedforward gains (all 8)
  private _nodes: (GainNode | DelayNode | OscillatorNode)[] = [];
  private readonly SR: number;

  constructor(private ctx: AudioContext) {
    this.SR = (ctx as any).sampleRate ?? 48000;
    this.inputL = ctx.createGain();
    this.inputR = ctx.createGain();
    this.outputL = ctx.createGain();
    this.outputR = ctx.createGain();
    this._build();
  }

  /** decay: 0–1 → feedback gain ~0.1–0.95 */
  setDecay(decay: number): void {
    const g = 0.1 + decay * 0.85;
    this._decayGains.forEach((n) => {
      n.gain.value = g;
    });
  }

  /** damping: 0–1 → 1-pole cutoff coefficient (0 = full bandwidth, 1 = muted) */
  setDamping(damping: number): void {
    const d = Math.max(0, Math.min(0.9999, damping));
    this._dampCoeffs.forEach((n) => {
      n.gain.value = 1 - d;
    });
    this._dampFeedb.forEach((n) => {
      n.gain.value = d;
    });
  }

  /** diffusion: 0–1 → scales input diffusion coefficients 0.5–0.75/0.625 */
  setDiffusion(diffusion: number): void {
    // Input AP1&2 range 0.5–0.75, AP3&4 range 0.4–0.625
    // This is a simplified mapping; tune by ear
    const g1 = 0.5 + diffusion * 0.25;
    const g2 = 0.4 + diffusion * 0.225;
    // _allpassFwd[0..1] = input AP1&2 fwd, [2..3] = AP3&4 fwd; fbk mirrors
    [0, 1].forEach((i) => {
      this._allpassFwd[i].gain.value = g1;
      this._allpassFbk[i].gain.value = -g1;
    });
    [2, 3].forEach((i) => {
      this._allpassFwd[i].gain.value = g2;
      this._allpassFbk[i].gain.value = -g2;
    });
  }

  dispose(): void {
    [
      this.inputL,
      this.inputR,
      this.outputL,
      this.outputR,
      ...this._nodes,
    ].forEach((n) => n.disconnect());
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Build a Schroeder allpass. g can be negative (decay diffusion 1). */
  private _allpass(
    delaySamples: number,
    g: number,
  ): { delay: DelayNode; input: GainNode; output: GainNode } {
    const SR = this.SR;
    const delay = this.ctx.createDelay(st(delaySamples, SR) + 1 / SR);
    delay.delayTime.value = st(delaySamples, SR);

    // Lattice: two multipliers with the same magnitude, opposite sign for feedback
    const fwd = this.ctx.createGain();
    fwd.gain.value = g; // feedforward
    const fbk = this.ctx.createGain();
    fbk.gain.value = -g; // feedback
    const sumIn = this.ctx.createGain();
    sumIn.gain.value = 1;
    const sumOut = this.ctx.createGain();
    sumOut.gain.value = 1;

    sumIn.connect(delay);
    delay.connect(sumOut); // direct path through delay
    delay.connect(fwd);
    fwd.connect(sumOut); // feedforward
    sumOut.connect(fbk);
    fbk.connect(sumIn); // feedback

    this._nodes.push(delay, fwd, fbk, sumIn, sumOut);
    this._allpassFwd.push(fwd);
    this._allpassFbk.push(fbk);
    return { delay, input: sumIn, output: sumOut };
  }

  /** Build a first-order single-pole IIR: y[n] = (1−k)·x[n] + k·y[n−1] */
  private _pole(k: number): { input: GainNode; output: GainNode } {
    const SR = this.SR;
    const z1 = this.ctx.createDelay(1 / SR + 1 / SR); // one-sample delay
    z1.delayTime.value = 1 / SR;
    const coeff = this.ctx.createGain();
    coeff.gain.value = 1 - k; // direct
    const feedb = this.ctx.createGain();
    feedb.gain.value = k; // IIR
    const sumOut = this.ctx.createGain();
    sumOut.gain.value = 1;

    coeff.connect(sumOut); // (1−k)·x[n]
    feedb.connect(sumOut); // k·y[n−1]  (delayed feedback)
    sumOut.connect(z1); // delay the output by one sample
    z1.connect(feedb); // feed delayed output back through k

    this._nodes.push(z1, coeff, feedb, sumOut);
    this._dampCoeffs.push(coeff);
    this._dampFeedb.push(feedb);
    return { input: coeff, output: sumOut };
  }

  /** Build a tap DelayNode reading N samples back from a source delay's input */
  private _tap(
    source: DelayNode,
    offsetSamples: number,
    weight: number,
  ): GainNode {
    const SR = this.SR;
    const tap = this.ctx.createDelay(st(offsetSamples, SR) + 1 / SR);
    tap.delayTime.value = st(offsetSamples, SR);
    const scale = this.ctx.createGain();
    scale.gain.value = weight;
    source.connect(tap);
    tap.connect(scale);
    this._nodes.push(tap, scale);
    return scale;
  }

  private _build(): void {
    const ctx = this.ctx;
    const SR = this.SR;

    // --- Stereo input → mono sum at ×½ ---
    const monoSum = ctx.createGain();
    monoSum.gain.value = 0.5;
    this.inputL.connect(monoSum);
    this.inputR.connect(monoSum);

    // --- Predelay (optional; set to 0 to disable) ---
    const predelay = ctx.createDelay(0.1);
    predelay.delayTime.value = 0; // set non-zero for early-reflection pre-delay
    monoSum.connect(predelay);

    // --- Bandwidth pre-filter (1-pole IIR, k = 0.9995 default) ---
    const bw = this._pole(0.9995);
    predelay.connect(bw.input);
    const diffused0 = bw.output;

    // --- Input diffusion: 4 cascaded allpasses ---
    // AP1 & AP2: input diffusion 1 = +0.750
    // AP3 & AP4: input diffusion 2 = +0.625
    const idap1 = this._allpass(142, +0.75);
    const idap2 = this._allpass(107, +0.75);
    const idap3 = this._allpass(379, +0.625);
    const idap4 = this._allpass(277, +0.625);

    diffused0.connect(idap1.input);
    idap1.output.connect(idap2.input);
    idap2.output.connect(idap3.input);
    idap3.output.connect(idap4.input);
    const diffused = idap4.output;

    // --- Tank: decay gain (applied after damping filter, per Fig. 1) ---
    const decayL = ctx.createGain();
    decayL.gain.value = 0.5;
    const decayR = ctx.createGain();
    decayR.gain.value = 0.5;
    this._decayGains.push(decayL, decayR);

    // --- Left loop (nodes 23–39 in the paper) ---
    // Mod AP left: decay diffusion 1, g = −0.700 (NEGATIVE per Fig. 1 "note sign")
    const apModL = this._allpass(672, -0.7);
    const dL1 = ctx.createDelay(st(4453, SR) + 1 / SR);
    dL1.delayTime.value = st(4453, SR);
    const dampL = this._pole(0.0005); // k = damping default
    // AP L2: decay diffusion 2, g = +0.500
    const apL2 = this._allpass(1800, +0.5);
    const dL2 = ctx.createDelay(st(3720, SR) + 1 / SR);
    dL2.delayTime.value = st(3720, SR);

    // --- Right loop (nodes 46–63 in the paper) ---
    // Mod AP right: quadrature LFO, same excursion, g = −0.700
    const apModR = this._allpass(908, -0.7);
    const dR1 = ctx.createDelay(st(4217, SR) + 1 / SR);
    dR1.delayTime.value = st(4217, SR);
    const dampR = this._pole(0.0005);
    // AP R2: decay diffusion 2, g = +0.500
    const apR2 = this._allpass(2656, +0.5);
    const dR2 = ctx.createDelay(st(3163, SR) + 1 / SR);
    dR2.delayTime.value = st(3163, SR);

    this._nodes.push(dL1, dL2, dR1, dR2, predelay, monoSum);

    // --- LFO modulation of the two modulated allpass delays ---
    // Quadrature pair at ~1 Hz; EXCURSION = 16 samples at reference rate
    const excursionSec = sc(16, SR) / SR;

    const lfoL = ctx.createOscillator();
    lfoL.frequency.value = 0.9; // ~1 Hz
    lfoL.type = "sine";
    const lfoLGain = ctx.createGain();
    lfoLGain.gain.value = excursionSec;
    lfoL.connect(lfoLGain);
    lfoLGain.connect(apModL.delay.delayTime);
    lfoL.start(0);

    const lfoR = ctx.createOscillator();
    lfoR.frequency.value = 0.9;
    lfoR.type = "sine";
    // Phase-shift LFO R by 90° using a 0.25/freq second offset
    const lfoRGain = ctx.createGain();
    lfoRGain.gain.value = excursionSec;
    // Note: true quadrature requires phase-offset at .start(); here we use a
    // cosine approximation by starting at ctx.currentTime + 0.25/0.9 ≈ 0.278s
    lfoR.connect(lfoRGain);
    lfoRGain.connect(apModR.delay.delayTime);
    lfoR.start(ctx.currentTime + 0.25 / 0.9);

    this._nodes.push(lfoL, lfoLGain, lfoR, lfoRGain);

    // --- Wire left loop ---
    const leftSum = ctx.createGain();
    leftSum.gain.value = 1;
    diffused.connect(leftSum); // tank input
    // right cross-feed wired below
    leftSum.connect(apModL.input);
    apModL.output.connect(dL1);
    dL1.connect(dampL.input);
    dampL.output.connect(decayL);
    decayL.connect(apL2.input);
    apL2.output.connect(dL2);

    // --- Wire right loop ---
    const rightSum = ctx.createGain();
    rightSum.gain.value = 1;
    diffused.connect(rightSum);
    rightSum.connect(apModR.input);
    apModR.output.connect(dR1);
    dR1.connect(dampR.input);
    dampR.output.connect(decayR);
    decayR.connect(apR2.input);
    apR2.output.connect(dR2);

    this._nodes.push(leftSum, rightSum);

    // --- Cross-feeds (figure-of-8) ---
    dL2.connect(rightSum); // left tail → right input
    dR2.connect(leftSum); // right tail → left input

    // --- Output taps (Table 2 of the paper, all weights = ±0.6) ---
    // Each tap is a separate DelayNode reading N samples back inside its source.
    // node24_30 = dL1 (4453 samples), node31_33 = apL2.delay (1800),
    // node33_39 = dL2 (3720), node48_54 = dR1 (4217),
    // node55_59 = apR2.delay (2656), node59_63 = dR2 (3163)

    const tapSrc = {
      dL1: dL1,
      apL2d: apL2.delay,
      dL2: dL2,
      dR1: dR1,
      apR2d: apR2.delay,
      dR2: dR2,
    };

    // Left output
    this._tap(tapSrc.dR1, 266, +0.6).connect(this.outputL);
    this._tap(tapSrc.dR1, 2974, +0.6).connect(this.outputL);
    this._tap(tapSrc.apR2d, 1913, -0.6).connect(this.outputL);
    this._tap(tapSrc.dR2, 1996, +0.6).connect(this.outputL);
    this._tap(tapSrc.dL1, 1990, -0.6).connect(this.outputL);
    this._tap(tapSrc.apL2d, 187, -0.6).connect(this.outputL);
    this._tap(tapSrc.dL2, 1066, -0.6).connect(this.outputL);

    // Right output
    this._tap(tapSrc.dL1, 353, +0.6).connect(this.outputR);
    this._tap(tapSrc.dL1, 3627, +0.6).connect(this.outputR);
    this._tap(tapSrc.apL2d, 1228, -0.6).connect(this.outputR);
    this._tap(tapSrc.dL2, 2673, +0.6).connect(this.outputR);
    this._tap(tapSrc.dR1, 2111, -0.6).connect(this.outputR);
    this._tap(tapSrc.apR2d, 335, -0.6).connect(this.outputR);
    this._tap(tapSrc.dR2, 121, -0.6).connect(this.outputR);
  }
}
```

### Integration into `AudioEngine.ts`

After the existing `WaveShaper → Filter` stage, insert the reverb as a parallel
wet path:

```
WaveShaper ─→ Filter ─→ ─────────────────────────────────────────── MasterGain → out
                    └──→ reverbSendGain ─→ PlateReverb.input
                                              ├─ outputL ─→ wetGainL ─┐
                                              └─ outputR ─→ wetGainR ─┴─→ MasterGain
```

`texture` param → `PlateReverb.setDiffusion()`  
`brightness` param → `PlateReverb.setDamping()`  
`mood` param → `PlateReverb.setDecay()` (wetter/longer tail at high mood)

---

## Phase 2: `WorkletProcessingNode` implementation

### Why migrate

The graph-based implementation requires ~40 native node objects. On mobile every
`.connect()` call and every `AudioParam` automation crosses the JS↔native bridge.
For a static reverb this is fine; for per-parameter modulation it adds up.

`WorkletProcessingNode` collapses the entire reverb — all delay lines, all
allpass math, both feedback loops — into a single native callback. The only
bridge traffic is parameter updates at most a few times per second.

### How `WorkletProcessingNode` works

```typescript
const reverb = ctx.createWorkletProcessingNode(
  (
    inputData: Float32Array[], // [0] = mono/stereo input channels
    outputData: Float32Array[], // [0] = left out, [1] = right out
    framesToProcess: number, // number of samples this call (typically 128)
    currentTime: number,
  ) => {
    "worklet";
    // Runs on the audio thread. No async, no allocations, no closures
    // over mutable JS state.
    // Read from inputData[0][i], write to outputData[0][i] and outputData[1][i]
  },
  "AudioRuntime", // runs on dedicated audio thread, not UI thread
);
```

The callback is a **Reanimated worklet** — it must be annotated `'worklet'` and
can only close over serialisable values captured at creation time. All mutable
state (delay line ring buffers, read/write heads) must live in `Float32Array`
instances captured in the closure at construction time — they are passed by
reference to the worklet runtime.

### Worklet reverb data layout

```typescript
const SR = 48000;
const REF = 29761; // Dattorro's reference sample rate

// Helper: scale sample count from reference rate to SR, with headroom
function scBuf(n: number): number {
  return Math.ceil((n * SR) / REF) + 32;
}

// Circular buffers — one per delay line + one per 1-pole filter state
// Sizes derived from the paper's sample counts at REF rate, scaled to SR.
const bufAP1 = new Float32Array(scBuf(142)); // input AP 1 (142 @ ref)
const bufAP2 = new Float32Array(scBuf(107)); // input AP 2
const bufAP3 = new Float32Array(scBuf(379)); // input AP 3
const bufAP4 = new Float32Array(scBuf(277)); // input AP 4
const bufAPML = new Float32Array(scBuf(672 + 16 + 32)); // mod AP left (+EXCURSION+extra)
const bufDL1 = new Float32Array(scBuf(4453)); // tank delay L1
const bufAPL2 = new Float32Array(scBuf(1800)); // tank AP left 2 delay
const bufDL2 = new Float32Array(scBuf(3720)); // tank delay L2
const bufAPMR = new Float32Array(scBuf(908 + 16 + 32)); // mod AP right
const bufDR1 = new Float32Array(scBuf(4217)); // tank delay R1
const bufAPR2 = new Float32Array(scBuf(2656)); // tank AP right 2 delay
const bufDR2 = new Float32Array(scBuf(3163)); // tank delay R2

// 1-pole filter state (single-sample memory per filter)
const bwState = new Float32Array(1); // bandwidth pre-filter y[n-1]
const dampLState = new Float32Array(1); // tank damp L y[n-1]
const dampRState = new Float32Array(1); // tank damp R y[n-1]

// Write-head positions, one per buffer (indexed same as above)
const heads = new Int32Array(12);

// Mutable parameters written from JS thread:
// [0]=decay, [1]=bandwidth_k, [2]=damping_k, [3]=lfoLPhase, [4]=lfoRPhase
const params = new Float32Array(5);
params[0] = 0.5; // decay
params[1] = 0.9995; // bandwidth coefficient
params[2] = 0.0005; // damping coefficient
// lfo phases initialised to 0 and π/2 for quadrature
params[3] = 0;
params[4] = Math.PI / 2;
```

The worklet callback then performs sample-by-sample processing:

```typescript
function circRead(buf: Float32Array, head: number, delayN: number): number {
  "worklet";
  const N = buf.length;
  return buf[(((head - delayN) % N) + N) % N];
}

function circWrite(buf: Float32Array, head: number, val: number): number {
  "worklet";
  buf[head] = val;
  return (head + 1) % buf.length;
}

/** Schroeder allpass: writes to buf, returns allpass output */
function allpass(
  buf: Float32Array,
  head: number,
  delayN: number,
  g: number,
  x: number,
): { y: number; nextHead: number } {
  "worklet";
  const v = circRead(buf, head, delayN);
  const w = x - g * v; // feedback path
  const y = v + g * w; // feedforward path
  const nextHead = circWrite(buf, head, w);
  return { y, nextHead };
}

/** 1-pole IIR lowpass: y[n] = (1−k)·x[n] + k·y[n−1] */
function pole1(state: Float32Array, k: number, x: number): number {
  "worklet";
  const y = (1 - k) * x + k * state[0];
  state[0] = y;
  return y;
}
```

Inside the per-sample loop:

```typescript
// Advance LFO phases (~1 Hz quadrature pair)
const lfoFreq = 0.9;
params[3] = (params[3] + (2 * Math.PI * lfoFreq) / SR) % (2 * Math.PI);
params[4] = (params[4] + (2 * Math.PI * lfoFreq) / SR) % (2 * Math.PI);

// EXCURSION = 16 samples at REF rate, scaled
const excursion = Math.round((16 * SR) / REF);
const modL = Math.round(Math.sin(params[3]) * excursion);
const modR = Math.round(Math.sin(params[4]) * excursion);
const modAPMLSamples = Math.round((672 * SR) / REF) + modL;
const modAPMRSamples = Math.round((908 * SR) / REF) + modR;

const decay = params[0];
const bw_k = params[1];
const damp_k = params[2];

// 1. Bandwidth pre-filter
const bwOut = pole1(bwState, bw_k, inputSample);

// 2. Input diffusion (g POSITIVE for all four)
let s = bwOut;
s = allpass(bufAP1, heads[0], Math.round((142 * SR) / REF), +0.75, s).y;
s = allpass(bufAP2, heads[1], Math.round((107 * SR) / REF), +0.75, s).y;
s = allpass(bufAP3, heads[2], Math.round((379 * SR) / REF), +0.625, s).y;
s = allpass(bufAP4, heads[3], Math.round((277 * SR) / REF), +0.625, s).y;

// 3. Tank (left and right loops with cross-feed)
//    left loop input = diffused + right loop feedback
//    right loop input = diffused + left loop feedback
// ... (see full worklet file for complete sample loop)
```

### Parameter updates from JS

Since worklet closures are serialised at construction time, mutable parameters
are communicated through the shared `Float32Array`:

```typescript
// On JS thread (inside AudioEngine setters):
reverbParams[0] = newDecay; // picked up on next audio callback

// Inside worklet — just read the array:
const decay = params[0];
```

This is safe because Float32Array element writes are atomic on all platforms
that `react-native-audio-api` targets (iOS/Android ARM).

---

## Phase 3: TurboModule C++ implementation (optimal)

### Why this is the right long-term answer

The worklet path is a significant improvement over the graph approach, but it still
has a ceiling. Reanimated worklets execute in a JS runtime (Hermes or V8) hosted on
a dedicated thread — the runtime is fast, but it is still a scripting engine. The
`'worklet'` annotation prohibits allocations and complex control flow, and there is no
access to SIMD intrinsics, platform audio session APIs, or fine-grained scheduling
primitives.

A TurboModule written in C++ removes all of those constraints:

| Concern | Graph | Worklet | TurboModule C++ |
|---|---|---|---|
| DSP runs at | audio thread | audio thread | audio thread |
| Language | TypeScript (JS runtime) | TypeScript (Hermes worklet) | C++ (native) |
| Allocations at runtime | per-node setup | pre-allocated only | zero — pre-allocated |
| Floating-point | double (JS default) | float32 (typed arrays) | float (NEON SIMD optional) |
| Interpolation (LFO mod) | no — zipper noise | manual linear interp | inline, branchless |
| Platform audio session | no | no | yes (AVAudioSession, Oboe) |
| Param delivery | `AudioParam` + bridge | `Float32Array` write | `std::atomic` + ring buffer |
| Node count in graph | ~40 | 1 (`WorkletProcessingNode`) | 0 (lives outside graph) |
| Debugging | Web Audio inspector | `console.log` smuggled via `runOnJS` | LLDB / Android Studio |

The TurboModule fits directly into the native DSP infrastructure described in
`native-dsp-infrastructure-plan.md`. `DattorroReverb` is a second `AudioModule`
subclass; adding it requires no structural changes to the bridge layer.

---

### C++ header

```cpp
// modules/core/include/DattorroReverb.h
#pragma once
#include "AudioModule.h"
#include <array>
#include <atomic>
#include <cmath>

class DattorroReverb : public AudioModule {
public:
    enum Param : int {
        DECAY       = 0,  // 0.0–1.0; controls feedback gain (default 0.50)
        DAMPING     = 1,  // 0.0–1.0; in-tank 1-pole coefficient (default 0.0005)
        BANDWIDTH   = 2,  // 0.0–1.0; pre-filter coefficient (default 0.9995)
        DIFFUSION   = 3,  // 0.0–1.0; scales input AP coefficients
        PREDELAY_MS = 4,  // 0–100 ms
        WET_DRY     = 5,  // 0.0–1.0 mix
    };

    void prepare(double sampleRate, int blockSize) override;
    void process(float* buffer, int numSamples) override;
    void reset() override;
    void setParameter(int paramId, float value) override;
    const char* getName() const override { return "DattorroReverb"; }

private:
    // ── Circular buffer helpers ─────────────────────────────────────────────
    struct DelayLine {
        std::vector<float> buf;
        int head = 0;

        void allocate(int size) { buf.assign(size, 0.0f); head = 0; }
        void clear()            { std::fill(buf.begin(), buf.end(), 0.0f); head = 0; }

        void write(float x) {
            buf[head] = x;
            if (++head >= static_cast<int>(buf.size())) head = 0;
        }

        // Read N samples back from current write position
        float read(int n) const {
            int N = static_cast<int>(buf.size());
            int pos = ((head - n) % N + N) % N;
            return buf[pos];
        }

        // Linear interpolation for fractional delay (LFO modulation)
        float readFrac(float n) const {
            int i0 = static_cast<int>(n);
            float frac = n - static_cast<float>(i0);
            return read(i0) * (1.0f - frac) + read(i0 + 1) * frac;
        }
    };

    // ── Schroeder allpass ───────────────────────────────────────────────────
    struct Allpass {
        DelayLine line;
        float g = 0.0f;

        void allocate(int delaySamples, float coeff) {
            line.allocate(delaySamples + 2); // +2 for interpolation headroom
            g = coeff;
        }

        float process(float x, int delaySamples) {
            float v = line.read(delaySamples);
            float w = x - g * v;
            float y = v + g * w;
            line.write(w);
            return y;
        }

        // Modulated variant: delaySamples can vary per-sample (LFO)
        float processMod(float x, float delaySamples) {
            float v = line.readFrac(delaySamples);
            float w = x - g * v;
            float y = v + g * w;
            line.write(w);
            return y;
        }
    };

    // ── 1-pole IIR lowpass: y[n] = (1−k)·x[n] + k·y[n−1] ─────────────────
    struct Pole1 {
        float state = 0.0f;
        float process(float x, float k) {
            state = (1.0f - k) * x + k * state;
            return state;
        }
        void clear() { state = 0.0f; }
    };

    // ── Scale sample count from Dattorro's reference rate ──────────────────
    int sc(int refSamples) const {
        return static_cast<int>(std::floor(refSamples * sampleRate_ / 29761.0));
    }

    // ── DSP state ──────────────────────────────────────────────────────────
    double sampleRate_ = 48000.0;

    // Input section
    DelayLine predelayLine_;
    Pole1     bandwidth_;
    Allpass   ap1_, ap2_, ap3_, ap4_;

    // Tank — left loop
    Allpass   apModL_;     // modulated, g = −0.700
    DelayLine dL1_;
    Pole1     dampL_;
    Allpass   apL2_;       // g = +0.500
    DelayLine dL2_;

    // Tank — right loop
    Allpass   apModR_;     // modulated, g = −0.700
    DelayLine dR1_;
    Pole1     dampR_;
    Allpass   apR2_;       // g = +0.500
    DelayLine dR2_;

    // LFO state (quadrature pair, ~1 Hz)
    float lfoPhaseL_ = 0.0f;
    float lfoPhaseR_ = static_cast<float>(M_PI / 2.0); // 90° offset

    // Smoothed working parameters (updated per-block)
    float decaySmooth_     = 0.50f;
    float dampingSmooth_   = 0.0005f;
    float bandwidthSmooth_ = 0.9995f;

    // Atomic parameters (written from JS thread, read each block)
    std::atomic<float> decay_     {0.50f};
    std::atomic<float> damping_   {0.0005f};
    std::atomic<float> bandwidth_ {0.9995f};
    std::atomic<float> diffusion_ {1.0f};   // 0–1 scales AP coefficients
    std::atomic<float> predelayMs_{0.0f};
    std::atomic<float> wetDry_    {0.33f};
};
```

---

### C++ implementation

```cpp
// modules/core/src/DattorroReverb.cpp
#include "DattorroReverb.h"

static constexpr float LFO_FREQ   = 0.9f;   // Hz
static constexpr float TAP_WEIGHT = 0.6f;

void DattorroReverb::prepare(double sampleRate, int blockSize) {
    sampleRate_ = sampleRate;

    // Pre-delay: max 100ms headroom
    predelayLine_.allocate(static_cast<int>(sampleRate * 0.1) + 4);

    // Input diffusion allpasses
    ap1_.allocate(sc(142), +0.750f);
    ap2_.allocate(sc(107), +0.750f);
    ap3_.allocate(sc(379), +0.625f);
    ap4_.allocate(sc(277), +0.625f);

    // Tank allpasses — EXCURSION headroom (sc(16) samples) added to modulated lines
    apModL_.allocate(sc(672) + sc(16) + 4, -0.700f);
    dL1_.allocate(sc(4453) + 4);
    apL2_.allocate(sc(1800), +0.500f);
    dL2_.allocate(sc(3720) + 4);

    apModR_.allocate(sc(908) + sc(16) + 4, -0.700f);
    dR1_.allocate(sc(4217) + 4);
    apR2_.allocate(sc(2656), +0.500f);
    dR2_.allocate(sc(3163) + 4);

    reset();
}

void DattorroReverb::reset() {
    predelayLine_.clear();
    bandwidth_.clear(); dampL_.clear(); dampR_.clear();
    ap1_.line.clear(); ap2_.line.clear(); ap3_.line.clear(); ap4_.line.clear();
    apModL_.line.clear(); dL1_.clear(); apL2_.line.clear(); dL2_.clear();
    apModR_.line.clear(); dR1_.clear(); apR2_.line.clear(); dR2_.clear();
    lfoPhaseL_ = 0.0f;
    lfoPhaseR_ = static_cast<float>(M_PI / 2.0);
}

void DattorroReverb::setParameter(int paramId, float value) {
    switch (static_cast<Param>(paramId)) {
        case DECAY:       decay_.store(value,     std::memory_order_relaxed); break;
        case DAMPING:     damping_.store(value,   std::memory_order_relaxed); break;
        case BANDWIDTH:   bandwidth_.store(value, std::memory_order_relaxed); break;
        case DIFFUSION:   diffusion_.store(value, std::memory_order_relaxed); break;
        case PREDELAY_MS: predelayMs_.store(value,std::memory_order_relaxed); break;
        case WET_DRY:     wetDry_.store(value,    std::memory_order_relaxed); break;
    }
}

void DattorroReverb::process(float* buffer, int numSamples) {
    // ── Smooth parameters once per block ──────────────────────────────────
    const float k       = 0.05f; // smoothing coefficient
    const float sr      = static_cast<float>(sampleRate_);
    const float lfoInc  = 2.0f * static_cast<float>(M_PI) * LFO_FREQ / sr;
    const float excursion = static_cast<float>(sc(16));

    decaySmooth_     += k * (decay_.load(std::memory_order_relaxed)     - decaySmooth_);
    dampingSmooth_   += k * (damping_.load(std::memory_order_relaxed)   - dampingSmooth_);
    bandwidthSmooth_ += k * (bandwidth_.load(std::memory_order_relaxed) - bandwidthSmooth_);

    const float diff   = diffusion_.load(std::memory_order_relaxed);
    const float wet    = wetDry_.load(std::memory_order_relaxed);
    const float dry    = 1.0f - wet;

    // Scale AP coefficients by diffusion knob
    // Canonical values: input AP1/2 = 0.75, AP3/4 = 0.625 (never exceed 0.999)
    const float g12 = 0.5f + diff * 0.25f;    // 0.50–0.75
    const float g34 = 0.4f + diff * 0.225f;   // 0.40–0.625
    ap1_.g = g12; ap2_.g = g12;
    ap3_.g = g34; ap4_.g = g34;

    // Predelay in samples
    const float pdMs    = predelayMs_.load(std::memory_order_relaxed);
    const int   pdSamps = static_cast<int>(pdMs * sr / 1000.0f);

    // Decay → feedback gain, mapped 0–1 → 0.10–0.95
    const float fbGain = 0.10f + decaySmooth_ * 0.85f;

    // ── Per-sample loop ────────────────────────────────────────────────────
    for (int i = 0; i < numSamples; ++i) {
        const float drySample = buffer[i];

        // 1. Predelay
        predelayLine_.write(drySample);
        float s = (pdSamps > 0) ? predelayLine_.read(pdSamps) : drySample;

        // 2. Bandwidth pre-filter (1-pole IIR, eq. y[n] = (1−k)·x[n] + k·y[n−1])
        s = bandwidth_.process(s, bandwidthSmooth_);

        // 3. Input diffusion (four cascaded Schroeder allpasses)
        s = ap1_.process(s, sc(142));
        s = ap2_.process(s, sc(107));
        s = ap3_.process(s, sc(379));
        s = ap4_.process(s, sc(277));
        const float tankIn = s;

        // 4. LFO modulation values (quadrature, ~1 Hz)
        const float modL = excursion * std::sin(lfoPhaseL_);
        const float modR = excursion * std::sin(lfoPhaseR_);
        lfoPhaseL_ += lfoInc; if (lfoPhaseL_ > 2.0f * M_PI) lfoPhaseL_ -= 2.0f * M_PI;
        lfoPhaseR_ += lfoInc; if (lfoPhaseR_ > 2.0f * M_PI) lfoPhaseR_ -= 2.0f * M_PI;

        // 5. Tank — left loop (reads right cross-feed from dR2)
        //    Cross-feed values come from the end of the *previous* sample's loops.
        //    Reading here (before writing this iteration) is the one-sample delay
        //    that the paper encodes in its feedback structure.
        const float crossFromR = dR2_.read(sc(3163));
        float leftIn = tankIn + fbGain * crossFromR;
        leftIn = apModL_.processMod(leftIn, static_cast<float>(sc(672)) + modL);
        dL1_.write(leftIn);
        float afterDL1 = dL1_.read(sc(4453));
        afterDL1 = dampL_.process(afterDL1, dampingSmooth_);
        afterDL1 *= fbGain;
        afterDL1 = apL2_.process(afterDL1, sc(1800));
        dL2_.write(afterDL1);

        // 6. Tank — right loop (reads left cross-feed from dL2)
        const float crossFromL = dL2_.read(sc(3720));
        float rightIn = tankIn + fbGain * crossFromL;
        rightIn = apModR_.processMod(rightIn, static_cast<float>(sc(908)) + modR);
        dR1_.write(rightIn);
        float afterDR1 = dR1_.read(sc(4217));
        afterDR1 = dampR_.process(afterDR1, dampingSmooth_);
        afterDR1 *= fbGain;
        afterDR1 = apR2_.process(afterDR1, sc(2656));
        dR2_.write(afterDR1);

        // 7. Output taps (Table 2 of Dattorro 1997; all weights ±0.6)
        //    Taps interleaved L/R and summed. Buffer is mono → write stereo
        //    requires the bridge to handle two output channels; see §integration.

        float yL =
            + TAP_WEIGHT * dR1_.read(sc(266))
            + TAP_WEIGHT * dR1_.read(sc(2974))
            - TAP_WEIGHT * apR2_.line.read(sc(1913))
            + TAP_WEIGHT * dR2_.read(sc(1996))
            - TAP_WEIGHT * dL1_.read(sc(1990))
            - TAP_WEIGHT * apL2_.line.read(sc(187))
            - TAP_WEIGHT * dL2_.read(sc(1066));

        float yR =
            + TAP_WEIGHT * dL1_.read(sc(353))
            + TAP_WEIGHT * dL1_.read(sc(3627))
            - TAP_WEIGHT * apL2_.line.read(sc(1228))
            + TAP_WEIGHT * dL2_.read(sc(2673))
            - TAP_WEIGHT * dR1_.read(sc(2111))
            - TAP_WEIGHT * apR2_.line.read(sc(335))
            - TAP_WEIGHT * dR2_.read(sc(121));

        // 8. Wet/dry mix and write back.
        //    The `process()` contract is mono in-place for the base class.
        //    The stereo output is stored in the interleaved stereo extension
        //    (see §stereo buffer note below).
        buffer[i] = dry * drySample + wet * (yL + yR) * 0.5f; // mono fallback
        // Stereo: handled by processStereoPair() — see below
    }
}
```

> **Stereo buffer note.** The `AudioModule` base class defines `process()` as a
> mono in-place operation. For a true stereo output the bridge calls an optional
> `processStereoPair(float* left, float* right, int n)` override, which writes
> `yL` and `yR` to separate channel buffers. Add this signature to `AudioModule.h`
> as a virtual with a default mono-fold implementation so all existing mono modules
> remain unaffected.

---

### Integration with the TurboModule infrastructure

Adding `DattorroReverb` to the existing infrastructure requires changes in exactly
three places — the factory function on each platform and the TypeScript layer.

**iOS factory (`AudioDSP.mm`):**

```objc
// In AudioDSPHost createModule:
if ([name isEqualToString:@"DattorroReverb"]) {
    mod = std::make_unique<DattorroReverb>();
}
```

**Android JNI factory (`AudioDSP.cpp`):**

```cpp
if (strcmp(name, "DattorroReverb") == 0) mod = std::make_unique<DattorroReverb>();
```

**TypeScript wrapper (`modules/js/modules/DattorroReverb.ts`):**

```typescript
import NativeAudioDSP from '../NativeAudioDSP';

export const DattorroReverbParams = {
  DECAY:       0,
  DAMPING:     1,
  BANDWIDTH:   2,
  DIFFUSION:   3,
  PREDELAY_MS: 4,
  WET_DRY:     5,
} as const;

export class DattorroReverbModule {
  private moduleId: number | null = null;

  async init(sampleRate = 48000): Promise<void> {
    this.moduleId = await NativeAudioDSP.createModule('DattorroReverb', sampleRate, 512);
    // Initialise to Dattorro Table 1 defaults
    await this.setBandwidth(0.9995);
    await this.setDamping(0.0005);
    await this.setDecay(0.50);
    await this.setDiffusion(1.0);
    await this.setWetDry(0.33);
  }

  async setDecay(v: number)      { await this._set(DattorroReverbParams.DECAY, v); }
  async setDamping(v: number)    { await this._set(DattorroReverbParams.DAMPING, v); }
  async setBandwidth(v: number)  { await this._set(DattorroReverbParams.BANDWIDTH, v); }
  async setDiffusion(v: number)  { await this._set(DattorroReverbParams.DIFFUSION, v); }
  async setPredelayMs(v: number) { await this._set(DattorroReverbParams.PREDELAY_MS, v); }
  async setWetDry(v: number)     { await this._set(DattorroReverbParams.WET_DRY, v); }

  async destroy(): Promise<void> {
    if (this.moduleId !== null) {
      await NativeAudioDSP.destroyModule(this.moduleId);
      this.moduleId = null;
    }
  }

  private async _set(paramId: number, value: number): Promise<void> {
    if (this.moduleId === null) throw new Error('DattorroReverbModule: call init() first');
    await NativeAudioDSP.setParameter(this.moduleId, paramId, value);
  }
}
```

**React hook:**

```typescript
// modules/js/useDattorroReverb.ts
import { useEffect, useRef } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import { DattorroReverbModule } from './modules/DattorroReverb';

export function useDattorroReverb() {
  const module = useRef<DattorroReverbModule | null>(null);

  // SharedValues for parameter coupling with Skia visuals
  const decay     = useSharedValue(0.5);
  const diffusion = useSharedValue(1.0);
  const wetDry    = useSharedValue(0.33);

  useEffect(() => {
    const mod = new DattorroReverbModule();
    module.current = mod;
    mod.init();
    return () => { mod.destroy(); };
  }, []);

  const setDecay = (v: number) => {
    decay.value = v;
    module.current?.setDecay(v);
  };
  const setDiffusion = (v: number) => {
    diffusion.value = v;
    module.current?.setDiffusion(v);
  };
  const setWetDry = (v: number) => {
    wetDry.value = v;
    module.current?.setWetDry(v);
  };

  return { setDecay, setDiffusion, setWetDry, decay, diffusion, wetDry };
}
```

---

### Mapping app parameters to reverb parameters

```
density   → setDiffusion()    higher density = denser tail (more allpass diffusion)
mood      → setDecay()        low mood = short dry reverb; high = long lush tail
brightness→ setDamping()      inverse mapping: low brightness = high damping (darker)
texture   → setPredelayMs()   subtle — shifts sense of room size (0–30 ms range)
```

---

### Performance characteristics

At 48 kHz, the TurboModule's `process()` inner loop performs the following per
sample:

- 1 bandwidth filter (2 multiplies, 1 add)
- 4 input allpass iterations (3 ops each = 12 total)
- 2 LFO sine evaluations (replaced with a fast phase accumulator — no `std::sin` per sample; use a quadrature oscillator instead for production)
- 2 modulated allpass iterations with linear interpolation (~6 ops each)
- 2 plain delay line reads/writes
- 2 damping filter evaluations
- 2 plain allpass iterations
- 14 output tap reads + 14 multiply-adds

This is approximately **80–100 arithmetic operations per sample** — around 4–5
million operations per second at 48 kHz. On a mobile ARM Cortex-A55 running at
1.8 GHz, that represents under **0.3% of a single core** at full load, leaving
ample headroom for the oscillator bank, Moog filter, and future modules running
in the same graph.

---

### Current graph

```
Voices → WaveShaper → BiquadFilter → MasterGain → destination
```

### Target graph with graph-based reverb

```
Voices → WaveShaper → BiquadFilter ─────────────────────────── MasterGain → destination
                                   └→ ReverbSend → PlateReverb → WetGain ──┘
```

Changes to `AudioEngine.ts`:

- Instantiate `PlateReverb` after the filter
- Add a `reverbSend` GainNode between the filter and reverb input
- Wire `PlateReverb.outputL` and `.outputR` into a stereo wet GainNode pair that
  connects to `MasterGain`
- Map `texture` → `setDiffusion`, `brightness` → `setDamping`, `mood` →
  `setDecay`
- Store `PlateReverb` instance; call `dispose()` in `stop()`

### Target graph with worklet-based reverb

```
Voices → WaveShaper → BiquadFilter → WorkletProcessingNode → MasterGain → destination
```

Changes to `AudioEngine.ts`:

- Replace the `BiquadFilter → MasterGain` chain with a single
  `WorkletProcessingNode` that implements the full plate reverb inline
- The node takes 1 input channel and produces 2 output channels
- Keep a reference to the `params: Float32Array` closed over by the worklet
- In each param setter, write directly to `params[i]` — no AudioParam
  automation needed

New file `src/audio/worklets/plateReverb.ts` exports:

- `createPlateReverbBuffers(sampleRate: number)` → all `Float32Array` buffers
  and `heads` array
- `makePlateReverbCallback(buffers, params)` → the worklet callback function
  (kept in its own file so it can be tested independently)

### Target graph with TurboModule reverb (optimal)

```
Voices → WaveShaper → MoogLadder TurboModule → DattorroReverb TurboModule → MasterGain → destination
```

In this configuration, `react-native-audio-api` manages only the oscillator bank,
master gain, and destination routing. Both DSP-intensive stages — the filter and
the reverb — are C++ TurboModule processors that the bridge inserts as native
processing nodes at audio-thread priority. The reverb module produces two output
channels (stereo) from a mono insert point; the bridge handles channel expansion.

Changes to `AudioEngine.ts`:

- Remove `WorkletProcessingNode` (or disable behind feature flag)
- Instantiate `DattorroReverbModule` and call `init()` in `AudioEngine.start()`
- Call `destroy()` in `AudioEngine.stop()`
- Wire parameter setters to the module's typed methods (see §mapping above)
- No changes to the oscillator bank or master gain chain

### No changes required in

- `useAudioEngine.ts` — the param bridge (`useAnimatedReaction` → `runOnJS`) is
  unchanged; the setters on `AudioEngine` keep the same signatures
- `useParams.ts` / `useParamDrift.ts` — completely unaffected
- `AmbientCanvas.tsx` / gestures — completely unaffected

---

## Migration path

```
Phase 1  Graph-based PlateReverb class
         ├─ Audible immediately, easy to tune individual stages
         └─ ~40 nodes; no worklet complexity

Phase 2  Worklet implementation alongside graph version
         ├─ Both live in AudioEngine behind a flag
         └─ A/B comparison possible at runtime

Phase 3  Validate worklet, remove graph version
         ├─ Ship worklet path only during prototype period
         └─ Confirms algorithm correctness before committing to native build

Phase 4  TurboModule C++ implementation (optimal target)
         ├─ DattorroReverb added to modules/core/ alongside MoogLadder
         ├─ Zero changes to bridge layer — factory-pattern drop-in
         ├─ Worklet version kept behind flag for A/B verification
         └─ Remove worklet path once TurboModule output is confirmed identical
```

A pair of feature flags in `AudioEngine.ts` is sufficient to navigate all four phases:

```typescript
const USE_WORKLET_REVERB   = false; // Phase 2/3: enable worklet path
const USE_TURBOMODULE_REVERB = false; // Phase 4: enable C++ TurboModule path
// Both false → graph-based (Phase 1)
// USE_WORKLET_REVERB true, USE_TURBOMODULE_REVERB false → worklet (Phase 2/3)
// USE_TURBOMODULE_REVERB true → TurboModule; ignores USE_WORKLET_REVERB
```

---

## Known constraints

- `WorkletProcessingNode` callbacks are Reanimated worklets: **no `new`
  allocations, no closures over non-serialisable values, no async**. All buffers
  must be pre-allocated before construction.
- Fractional-sample delay (for smooth LFO modulation) requires linear
  interpolation between two adjacent buffer reads — simple but necessary to
  avoid zipper noise.
- The `'AudioRuntime'` worklet runtime runs on a dedicated audio thread separate
  from both JS and UI threads — this is the correct runtime for this use case.
  `'UIRuntime'` would compete with Skia rendering.
- **TurboModule (Phase 4):** The `process()` contract in `AudioModule.h` is
  mono in-place. `DattorroReverb` requires a stereo output extension
  (`processStereoPair()`). Add this as a virtual with a default mono-fold
  implementation to `AudioModule.h` before implementing the reverb, so the base
  class remains compatible with all existing mono modules (e.g. `MoogLadder`).
- **TurboModule (Phase 4):** Per-sample `std::sin` for LFO modulation is
  acceptable for prototyping but should be replaced with a quadrature oscillator
  (two multiplies per sample using the recurrence `sin += ε·cos; cos -= ε·sin`)
  before finalising. At 48 kHz, two `std::sin` calls per sample represent a
  measurable but not critical cost on ARM; the substitution is a five-line change.
- **TurboModule (Phase 4):** A/B testing against the worklet path is the
  recommended verification strategy. Feed identical white noise through both
  implementations at the same parameters and diff the output buffers — any
  deviation beyond floating-point rounding indicates a structural error in the
  C++ port.
