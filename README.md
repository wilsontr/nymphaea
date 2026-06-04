# Nymphea

A generative ambient app — continuous procedural audio and visuals that evolve on their own and respond to touch. No play button, no transport controls.

---

## Getting started after checkout

### Prerequisites

- **Node.js 20+** — use [nvm](https://github.com/nvm-sh/nvm): `nvm install 20 && nvm use 20`
- **Watchman** (macOS): `brew install watchman`
- **iOS**: Xcode 15+ from the App Store, then:
  ```bash
  sudo xcode-select --switch /Applications/Xcode.app
  xcodebuild -runFirstLaunch
  ```
- **Android**: Android Studio with an emulator configured, and in your shell profile:
  ```bash
  export ANDROID_HOME=$HOME/Library/Android/sdk
  export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
  ```

### Install

```bash
npm install
```

### First-time native build (required once per machine)

The app uses native modules (`react-native-audio-api`, `@shopify/react-native-skia`, `expo-dev-client`) that can't run in Expo Go — a custom dev client build is needed.

```bash
npx expo run:ios        # builds and launches in the iOS simulator
npx expo run:android    # builds and launches in the Android emulator
```

This compiles the native layer. It takes a few minutes. You only need to redo it if you add or remove a native dependency.

### Day-to-day development (after the first build)

```bash
npx expo start --dev-client   # start the Metro bundler
```

Open the dev client app on your simulator/device and connect. JS changes hot-reload instantly without rebuilding.

```bash
npx expo start --clear        # if Metro gets into a bad state
```

---

## Architecture overview

The five abstract parameters (`density`, `mood`, `brightness`, `speed`, `texture`) are the single source of truth for everything. They live as Reanimated `SharedValue<number>` objects on the UI thread. The audio engine and the visual renderer both read from the same values — audio via `useAnimatedReaction`, visuals via `useDerivedValue` inside the Skia canvas.

```
Gesture input ──┐
Param drift LFO ┤──▶  SharedValues (UI thread)
                │           │                  │
                │    useDerivedValue       useAnimatedReaction
                │           │                  │
                │    Skia shader           runOnJS → AudioEngine
                │    (uniforms)            (JS thread)
                └───────────────────────────────┘
```

---

## Stable implementation (unlikely to change)

These pieces form the load-bearing skeleton of the architecture. They are intentionally decoupled from the creative layer and should rarely need modification.

### `src/params/useParams.ts`

Defines the five `SharedValue<number>` objects and their initial values. The only reason to edit this file is to add a new top-level parameter or change a default starting value.

### `src/audio/DroneVoice.ts`

A thin wrapper around a single `OscillatorNode + GainNode` pair. Exposes `setFrequency` and `setDetune` with linear ramp helpers. This is the lowest-level audio primitive; the synthesis character lives in `AudioEngine.ts`, not here.

### `src/audio/useAudioEngine.ts`

The bridge between the Reanimated world and the audio world. Uses one `useAnimatedReaction` per parameter to detect changes on the UI thread and push them to the engine via `runOnJS`. The structure of this file (one reaction per param) is fixed by the Reanimated API.

### `src/visuals/AmbientCanvas.tsx`

The Skia canvas component. Compiles the shader once on mount, ticks `time` via `useFrameCallback` on the UI thread, and assembles uniforms via `useDerivedValue` — all without touching the JS thread per frame. The component interface (`params` prop) is stable; only the shader source it references is expected to change.

### `src/gestures/useGestures.ts`

Maps touch gestures to parameter deltas. The gesture → parameter assignments are a creative decision; the worklet structure and `GestureDetector` wiring in `App.tsx` are fixed.

---

## Expected iteration points

These are the files you will edit repeatedly during creative development:

| File                               | What to change                                                 |
| ---------------------------------- | -------------------------------------------------------------- |
| `src/visuals/shaders/flowField.ts` | The SkSL shader — noise functions, colour palettes, warp logic |
| `src/audio/AudioEngine.ts`         | Voice ratios, oscillator types, filter curves, reverb          |
| `src/params/useParamDrift.ts`      | LFO rates, amplitude ranges, drift character                   |
| `src/gestures/useGestures.ts`      | Gesture sensitivity and parameter assignments                  |

### Adding a new shader

1. Add a new `const MY_SHADER = \`...\``export in`src/visuals/shaders/`.
2. Import it in `AmbientCanvas.tsx` and swap `FLOW_FIELD_SHADER` for the new constant.
3. Update the `uniforms` object in `useDerivedValue` if the new shader needs different uniform names.

### Adding a new parameter

1. Add a new `useSharedValue` in `useParams.ts` and include it in the `Params` type.
2. Add a setter in `AudioEngine.ts` and wire it in `useAudioEngine.ts`.
3. Add the new name to the `uniforms` object in `AmbientCanvas.tsx`.
4. Map a gesture to it in `useGestures.ts`.

---

## Tech stack

| Layer                | Library                        | Version |
| -------------------- | ------------------------------ | ------- |
| Project scaffold     | Expo SDK                       | 56      |
| Audio engine         | `react-native-audio-api`       | ^0.12   |
| GPU visuals          | `@shopify/react-native-skia`   | 2.6     |
| Animation / worklets | `react-native-reanimated`      | 4.x     |
| Gesture input        | `react-native-gesture-handler` | ~2.31   |
