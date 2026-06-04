# Generative Ambient App — Prototype Plan

> A React Native + Expo app producing generative ambient sound and procedural visuals,
> with minimal UI for real-time user influence.

---

## 1. Concept Summary

The app runs a continuous generative audio engine and a synchronized visual renderer. There is no "play" button — the experience starts on launch and evolves over time. The user can nudge parameters (density, mood, speed, texture) through a minimal touch interface. Audio and visuals share the same underlying parameter state so they always feel coupled.

**Design principles for the prototype:**
- Sound-first: visuals respond to audio parameters, not the other way around
- Continuous and stateful: everything drifts, morphs, and evolves
- Touch as influence, not control: gestures shift tendencies, not hard values
- No playback UI chrome — no timelines, scrubbers, or transport controls

---

## 2. Core Stack

| Layer | Library | Role |
|---|---|---|
| Project scaffold | Expo SDK (dev client) | Build, OTA updates, native module access |
| Audio engine | `react-native-audio-api` | Web Audio API–style graph: oscillators, filters, convolver, gain |
| Visuals | `@shopify/react-native-skia` | GPU-accelerated 2D canvas + SkSL fragment shaders |
| Animation bridge | `react-native-reanimated` v3 | Shared values + Worklets for JS-free parameter animation |
| Gesture input | `react-native-gesture-handler` | Swipe, pinch, and long-press for parameter influence |
| State / param bus | Reanimated `SharedValue` | Single source of truth for all parameters, readable by both audio and Skia |
| Navigation | None (single screen) | Not needed for prototype |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     JS Thread                            │
│                                                          │
│   ┌────────────────────┐    ┌─────────────────────────┐  │
│   │   GestureHandler   │    │   Param Scheduler       │  │
│   │  (swipes, taps)    │    │  (slow drift LFOs,      │  │
│   └────────┬───────────┘    │   random walks)         │  │
│            │                └────────────┬────────────┘  │
│            ▼                             ▼               │
│   ┌─────────────────────────────────────────────────┐    │
│   │         Shared Parameter Bus                    │    │
│   │   (Reanimated SharedValues)                     │    │
│   │                                                 │    │
│   │   density  mood  brightness  speed  texture     │    │
│   └──────────┬──────────────────────┬───────────────┘    │
│              │                      │                    │
└──────────────┼──────────────────────┼────────────────────┘
               │                      │
    ┌──────────▼──────┐    ┌──────────▼──────────┐
    │   UI Thread     │    │   Audio Thread       │
    │  (Worklet)      │    │                      │
    │                 │    │  react-native-       │
    │  Skia Canvas    │    │  audio-api           │
    │  SkSL Shader    │    │                      │
    │  (procedural    │    │  Oscillator graph,   │
    │   imagery)      │    │  filters, reverb,    │
    │                 │    │  gain automation     │
    └─────────────────┘    └──────────────────────┘
```

The key insight: **SharedValues are the bus.** Reanimated SharedValues can be read inside Skia's `useAnimatedStyle` / drawing callbacks on the UI thread (no JS round-trip), and they can also be read from JS to drive audio parameter changes. This gives you tight, low-jitter coupling between sound and image.

---

## 4. Parameter Model

These five abstract parameters live as SharedValues and control everything:

| Parameter | Range | Controls (audio) | Controls (visual) |
|---|---|---|---|
| `density` | 0–1 | Note event frequency, harmonic complexity | Particle count, shape complexity |
| `mood` | 0–1 | Filter cutoff, scale mode (minor ↔ major) | Hue rotation, warm ↔ cool palette |
| `brightness` | 0–1 | High-shelf gain, reverb wet/dry | Luminosity, contrast, bloom |
| `speed` | 0–1 | LFO rates, note duration | Animation speed, drift rate |
| `texture` | 0–1 | Oscillator waveform blend, noise amount | Shader grain/noise overlay |

Users interact with these through gesture zones on screen — no knobs or sliders. For example: a slow upward swipe raises `mood`; a circular gesture raises `density`; a two-finger spread raises `brightness`.

---

## 5. Audio Engine Design

### Graph Structure

```
Oscillator Bank (4–8 voices)
    │
    ├── Detune LFO (SharedValue: speed)
    │
    ▼
BiquadFilter (lowpass)
    │   cutoff ← f(mood, brightness)
    ▼
WaveShaper (soft clip / warmth)
    ▼
ConvolverNode (reverb IR)  ←── wet ← f(texture)
    │
    ▼
DynamicsCompressor
    │
    ▼
Master GainNode → AudioContext.destination
```

### Synthesis approach for prototype

Start with **additive drone synthesis**: a small bank of detuned oscillators with slowly drifting frequencies produces lush, evolving pads without complex DSP.

```
Base frequency: A2 (110 Hz) or user-nudged root
Voice 1: base × 1.00 + slow sine LFO detune
Voice 2: base × 1.50 (perfect fifth)
Voice 3: base × 2.00 (octave)
Voice 4: base × mood-interpolated (minor third ↔ major third)
Voice 5: base × 3.00 + texture-scaled noise
```

Frequency drift: each voice gets an independent slow random walk (0.01–0.1 Hz LFO) so the sound never feels static.

### Note event layer (optional second phase)

Layer sparse, quantized melodic events over the drone — drawn from a pentatonic or modal scale derived from `mood`. Event frequency scales with `density`. This adds variety without requiring complex scheduling.

---

## 6. Visual Engine Design

### Skia canvas structure

The canvas runs at 60fps, driven by a Reanimated `useFrameCallback` (UI thread only — no JS involvement per frame).

**Layer stack:**
1. Background gradient (slow color drift, hue from `mood`)
2. Shader layer — full-screen SkSL fragment shader for the primary procedural image
3. Particle system — lightweight JS-side array of points, drawn as Skia circles/paths
4. Vignette overlay (soft darkening at edges)
5. UI gesture zones (transparent touch targets)

### Primary SkSL shader sketch

A starting shader producing organic, flowing shapes:

```glsl
// Simplex-style noise field modulated by parameters
uniform float time;
uniform float density;
uniform float mood;
uniform float brightness;
uniform float texture;
uniform vec2 resolution;

// Domain-warped noise → organic blobs / flow fields
vec2 warp(vec2 p, float t) {
    float a = sin(p.x * density * 2.0 + t * 0.3);
    float b = cos(p.y * density * 2.0 + t * 0.2);
    return p + vec2(a, b) * texture;
}

half4 main(vec2 fragCoord) {
    vec2 uv = fragCoord / resolution;
    vec2 p = warp(uv * 3.0, time);

    float n = sin(p.x * 4.0) * cos(p.y * 4.0); // placeholder for noise
    float lum = brightness * 0.5 + n * 0.5;

    // mood: 0 = cool blue, 1 = warm amber
    vec3 cool = vec3(0.1, 0.2, 0.5);
    vec3 warm = vec3(0.6, 0.3, 0.1);
    vec3 color = mix(cool, warm, mood) * lum;

    return half4(color, 1.0);
}
```

Upgrade path: swap the placeholder noise for a proper value noise or FBM function — Skia's SkSL supports full GLSL-style math so you can port any existing generative GLSL shader.

---

## 7. Real-Time Parameter Bridge

The bridge is the most architecturally important piece. Here's the pattern:

```typescript
// Create shared values (live on UI thread)
const density  = useSharedValue(0.5);
const mood     = useSharedValue(0.3);
const speed    = useSharedValue(0.4);
// ... etc

// Skia reads them directly in drawing callback (UI thread, no bridge)
const paint = useAnimatedStyle(() => ({
  // driven by shared values
}));

// Audio update: JS thread polls or reacts to changes
useAnimatedReaction(
  () => mood.value,
  (current) => {
    runOnJS(updateAudioFilter)(current);
  },
  [mood]
);

// Gesture updates shared values (also triggers both sides)
const gesture = Gesture.Pan().onUpdate((e) => {
  mood.value = clamp(mood.value + e.translationY * -0.001, 0, 1);
});
```

`useAnimatedReaction` is the key primitive — it runs on the UI thread but can call `runOnJS` to push values to the audio engine when parameters change meaningfully, avoiding per-frame audio calls.

---

## 8. Local Dev Environment Setup

### Prerequisites

```bash
# Node.js 20+ (use nvm)
nvm install 20 && nvm use 20

# Expo CLI
npm install -g expo-cli eas-cli

# Watchman (macOS — strongly recommended)
brew install watchman

# iOS: Xcode 15+ from App Store, then:
sudo xcode-select --switch /Applications/Xcode.app
xcodebuild -runFirstLaunch

# Android: Android Studio, then set:
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

### Project Bootstrap

```bash
# Create Expo project with dev client (required for native modules)
npx create-expo-app@latest nymphaea --template blank-typescript
cd nymphaea

# Core dependencies
npx expo install expo-dev-client
npx expo install @shopify/react-native-skia
npx expo install react-native-reanimated
npx expo install react-native-gesture-handler

# Audio API (check for latest version on npm)
npm install react-native-audio-api

# Add Reanimated babel plugin to babel.config.js
# plugins: ['react-native-reanimated/plugin']
```

### Dev Client Build (one-time, required for native modules)

```bash
# iOS simulator
npx expo run:ios

# Android emulator
npx expo run:android

# After this, use Expo's fast refresh — no rebuild needed
# unless you change native dependencies
```

### Recommended VS Code Extensions

- **React Native Tools** (Microsoft)
- **ESLint** + **Prettier**
- **GLSL Literal** — syntax highlighting for shader strings
- **Error Lens** — inline TypeScript errors

### Useful Dev Commands

```bash
npx expo start --dev-client   # Start dev server
npx expo start --clear        # Clear Metro cache (if things get weird)
eas build --profile preview   # Build shareable preview .ipa/.apk
```

---

## 9. Project File Structure

```
nymphaea/
├── app/
│   └── index.tsx             # Root screen (single screen app)
├── src/
│   ├── audio/
│   │   ├── AudioEngine.ts    # AudioContext setup, node graph
│   │   ├── DroneVoice.ts     # Single oscillator voice
│   │   ├── NoteScheduler.ts  # Optional melodic layer
│   │   └── useAudioEngine.ts # Hook: init, cleanup, param bridge
│   ├── visuals/
│   │   ├── AmbientCanvas.tsx # Skia canvas component
│   │   ├── shaders/
│   │   │   ├── background.glsl
│   │   │   └── flowField.glsl
│   │   └── ParticleSystem.ts # Lightweight particle logic
│   ├── params/
│   │   ├── useParams.ts      # SharedValue definitions + exports
│   │   └── useParamDrift.ts  # Autonomous slow parameter evolution
│   ├── gestures/
│   │   └── useGestures.ts    # Gesture → param mapping
│   └── ui/
│       └── ParameterOverlay.tsx  # Minimal UI chrome (optional indicators)
├── assets/
│   └── ir/                   # Impulse response files for reverb
│       ├── hall.wav
│       └── cave.wav
├── app.json
├── babel.config.js
└── tsconfig.json
```

---

## 10. Prototyping Sequence

Work in this order to keep each step testable in isolation:

**Phase 1 — Audio skeleton**
Set up `AudioEngine.ts` with a single oscillator → filter → gain → output. Confirm sound in simulator. Add the basic drone voice bank. No UI yet.

**Phase 2 — Visual skeleton**
Get a full-screen Skia canvas rendering at 60fps with a placeholder colored background. Add the first SkSL shader (even a simple gradient). Confirm no frame drops.

**Phase 3 — Parameter bus**
Wire up SharedValues. Drive filter cutoff from `mood`, drive shader hue from `mood`. Confirm they move together.

**Phase 4 — Gesture input**
Add swipe gestures that modify SharedValues. Confirm audio and visual both respond without glitches.

**Phase 5 — Autonomous drift**
Add the slow parameter drift (random walks, LFOs on params). The experience should now evolve on its own without user input.

**Phase 6 — Polish**
Tune the shader, add particle layer, dial in reverb, refine gesture mappings, test on real device.

---

## 11. Known Gotchas

**Audio latency on Android:** Android's audio stack has significantly higher latency than iOS. For drone synthesis this is tolerable. If you add a melodic layer with user-triggered notes, you may need `AudioContext` with a low `latencyHint: 'playback'` and accept longer scheduling lookahead.

**`react-native-audio-api` maturity:** The library is actively developed but not 1.0. Pin your version and read the changelog before updating. The API surface mirrors Web Audio closely, so MDN's Web Audio API docs are useful references.

**Shader string management:** SkSL shaders are passed as JS template literal strings. Long shaders get unwieldy. Use `.glsl` files and import them as raw strings via a Metro transform (add `assetExts: ['glsl']` to `metro.config.js`).

**Reanimated + Skia thread model:** Skia drawing callbacks run on the UI thread via Worklets. Never call JS functions directly inside a Skia drawing callback — use `runOnJS` if you must cross back to JS, or better, keep everything in SharedValues.

**Impulse responses for reverb:** `ConvolverNode` needs an audio buffer loaded from a file. Ship a few small IR files (< 1MB each) in `assets/ir/`. Expo's `expo-asset` handles loading them.

**iOS simulator audio:** Audio works in the iOS simulator for testing the graph, but latency and behavior differ from a real device. Test on hardware before making final sound design decisions.

---

## 12. Resources

- [react-native-audio-api GitHub](https://github.com/software-mansion/react-native-audio-api)
- [React Native Skia docs](https://shopify.github.io/react-native-skia/)
- [SkSL Shading Language Reference](https://skia.org/docs/user/sksl/)
- [MDN Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) — mirrors react-native-audio-api closely
- [The Book of Shaders](https://thebookofshaders.com) — essential GLSL/SkSL fundamentals
- [Reanimated docs — Worklets](https://docs.swmansion.com/react-native-reanimated/docs/fundamentals/worklets/)
- [Ambient music theory / generative techniques](https://teropa.info/loop/) — Tero Parviainen's excellent write-up
