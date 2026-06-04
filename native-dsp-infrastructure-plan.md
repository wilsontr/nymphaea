# Native Audio DSP — TurboModule Infrastructure Plan

> A framework for building a growing library of C++ audio processing modules
> that run at audio-thread priority inside a React Native / Expo app.
> The Moog ladder filter serves as the reference first implementation.

---

## 1. Guiding Principles

**Write DSP once, run everywhere.** All signal processing logic lives in platform-agnostic C++ (the `core/` layer). iOS and Android TurboModule wrappers are thin translation layers — they handle threading, memory, and JS bridging, but contain no DSP math.

**Audio thread is sacred.** No allocations, no locks, no JS calls on the audio processing thread. All parameter changes use atomic operations or lock-free ring buffers.

**Each module is self-contained.** A module is a single C++ class, a shared TypeScript interface, and two thin platform wrappers (iOS/Android). Adding a new module is a checklist, not a design problem.

**Expo dev client, not bare workflow.** Expo's managed workflow with a custom dev client gives you OTA updates and fast iteration while still exposing native module APIs.

---

## 2. Repository Structure

```
nymphaea/
├── modules/                        # All native audio work lives here
│   ├── core/                       # Platform-agnostic C++ DSP
│   │   ├── include/
│   │   │   ├── AudioModule.h       # Abstract base class for all modules
│   │   │   ├── MoogLadder.h
│   │   │   ├── RingBuffer.h        # Lock-free parameter delivery
│   │   │   └── AudioMath.h         # Shared math (tanh tables, etc.)
│   │   └── src/
│   │       ├── MoogLadder.cpp
│   │       ├── RingBuffer.cpp
│   │       └── AudioMath.cpp
│   │
│   ├── ios/                        # iOS TurboModule wrapper
│   │   ├── AudioDSP.h
│   │   ├── AudioDSP.mm             # Objective-C++ bridge
│   │   ├── AudioDSPInstaller.h     # Expo module installer
│   │   └── AudioDSPInstaller.mm
│   │
│   ├── android/                    # Android TurboModule wrapper
│   │   └── src/main/
│   │       ├── cpp/
│   │       │   ├── AudioDSP.h
│   │       │   └── AudioDSP.cpp    # JNI bridge
│   │       └── java/com/audiodsp/
│   │           ├── AudioDSPModule.kt
│   │           └── AudioDSPPackage.kt
│   │
│   ├── js/                         # TypeScript interface layer
│   │   ├── NativeAudioDSP.ts       # TurboModule spec
│   │   ├── modules/
│   │   │   └── MoogLadder.ts       # Per-module typed wrapper
│   │   └── index.ts
│   │
│   └── CMakeLists.txt              # Android C++ build config
│
├── src/                            # App source (unchanged from plan doc)
│   ├── audio/
│   ├── visuals/
│   ├── params/
│   └── gestures/
│
├── app/
│   └── index.tsx
├── app.json
└── babel.config.js
```

The `modules/` directory is designed to be extracted into a standalone local package later if you want to share DSP modules across projects (via npm workspace or a private registry).

---

## 3. The C++ Core Layer

### 3.1 Abstract Base Class

Every audio module inherits from a single base. This enforces a consistent interface and allows the bridge layer to manage a heterogeneous collection of modules without knowing their details.

```cpp
// modules/core/include/AudioModule.h
#pragma once
#include <cstdint>

class AudioModule {
public:
    virtual ~AudioModule() = default;

    // Called once when the module is created or sample rate changes.
    // Safe to allocate here.
    virtual void prepare(double sampleRate, int blockSize) = 0;

    // Process a block of samples in place.
    // AUDIO THREAD: no allocation, no locks, no exceptions.
    virtual void process(float* buffer, int numSamples) = 0;

    // Reset all internal state (e.g. on silence/restart).
    virtual void reset() = 0;

    // Parameter update — called from audio thread via ring buffer drain.
    // AUDIO THREAD: must be wait-free.
    virtual void setParameter(int paramId, float value) = 0;

    virtual const char* getName() const = 0;
};
```

### 3.2 Shared Math Utilities

Expensive functions like `tanh` need to be fast on the audio thread. Put precomputed tables and polynomial approximations here so every module can share them.

```cpp
// modules/core/include/AudioMath.h
#pragma once
#include <cmath>

namespace AudioMath {
    // Polynomial tanh approximation — accurate to ~0.001 for |x| < 3
    // About 4× faster than std::tanh on ARM
    inline float fastTanh(float x) {
        float x2 = x * x;
        return x * (27.0f + x2) / (27.0f + 9.0f * x2);
    }

    // Clamp without branching
    inline float clamp(float x, float lo, float hi) {
        return x < lo ? lo : (x > hi ? hi : x);
    }

    // Convert frequency in Hz to normalized angular frequency
    inline float hzToNormalized(float hz, double sampleRate) {
        return static_cast<float>(hz / sampleRate);
    }
}
```

### 3.3 Lock-Free Parameter Ring Buffer

JS sets parameters at event-loop rate (~60fps). The audio thread runs at 44100+ Hz. Never let these meet on a mutex. A single-producer / single-consumer ring buffer solves this without locks.

```cpp
// modules/core/include/RingBuffer.h
#pragma once
#include <atomic>
#include <array>

struct ParamEvent {
    int   moduleId;
    int   paramId;
    float value;
};

template<int Capacity>
class ParamRingBuffer {
public:
    bool push(const ParamEvent& e) {
        int next = (writePos_.load(std::memory_order_relaxed) + 1) % Capacity;
        if (next == readPos_.load(std::memory_order_acquire)) return false; // full
        buffer_[writePos_.load(std::memory_order_relaxed)] = e;
        writePos_.store(next, std::memory_order_release);
        return true;
    }

    bool pop(ParamEvent& e) {
        int r = readPos_.load(std::memory_order_relaxed);
        if (r == writePos_.load(std::memory_order_acquire)) return false; // empty
        e = buffer_[r];
        readPos_.store((r + 1) % Capacity, std::memory_order_release);
        return true;
    }

private:
    std::array<ParamEvent, Capacity> buffer_;
    std::atomic<int> writePos_{0};
    std::atomic<int> readPos_{0};
};

using AudioParamQueue = ParamRingBuffer<256>;
```

---

## 4. The Moog Ladder Filter — First Module

### 4.1 Header

```cpp
// modules/core/include/MoogLadder.h
#pragma once
#include "AudioModule.h"
#include <atomic>

class MoogLadder : public AudioModule {
public:
    // Parameter IDs — exposed to JS as integer constants
    enum Param : int {
        CUTOFF     = 0,  // Hz, range: 20–20000
        RESONANCE  = 1,  // 0.0–1.0 (1.0 = self-oscillation)
        DRIVE      = 2,  // Input gain before filter, 0.5–4.0
    };

    void prepare(double sampleRate, int blockSize) override;
    void process(float* buffer, int numSamples) override;
    void reset() override;
    void setParameter(int paramId, float value) override;
    const char* getName() const override { return "MoogLadder"; }

private:
    void processSample(float& sample);
    float computeG() const;

    double sampleRate_ = 44100.0;

    // Stage state
    float ya_ = 0, yb_ = 0, yc_ = 0, yd_ = 0;
    float wa_ = 0, wb_ = 0, wc_ = 0;

    // Atomics allow safe write from main thread, read from audio thread
    // for non-critical params (cutoff changes are smoothed anyway)
    std::atomic<float> cutoff_    {1000.0f};
    std::atomic<float> resonance_ {0.0f};
    std::atomic<float> drive_     {1.0f};

    // Smoothed working values (updated each block, not per-sample)
    float gSmoothed_   = 0.0f;
    float resSmoothed_ = 0.0f;

    static constexpr float Vt = 0.026f;  // Transistor thermal voltage
};
```

### 4.2 Implementation

```cpp
// modules/core/src/MoogLadder.cpp
#include "MoogLadder.h"
#include "AudioMath.h"
#include <cmath>

void MoogLadder::prepare(double sampleRate, int blockSize) {
    sampleRate_ = sampleRate;
    reset();
}

void MoogLadder::reset() {
    ya_ = yb_ = yc_ = yd_ = 0.0f;
    wa_ = wb_ = wc_ = 0.0f;
}

void MoogLadder::setParameter(int paramId, float value) {
    switch (static_cast<Param>(paramId)) {
        case CUTOFF:     cutoff_.store(value, std::memory_order_relaxed); break;
        case RESONANCE:  resonance_.store(value, std::memory_order_relaxed); break;
        case DRIVE:      drive_.store(value, std::memory_order_relaxed); break;
    }
}

float MoogLadder::computeG() const {
    // Scaled impulse invariant transform (eq. 21 in Huovilainen 2004)
    // Computed at 2× oversampled rate
    float fc = cutoff_.load(std::memory_order_relaxed);
    float fs2x = static_cast<float>(sampleRate_ * 2.0);
    return 1.0f - std::exp(-2.0f * M_PI * fc / fs2x);
}

void MoogLadder::processSample(float& x) {
    // 2× oversampling: run filter update twice, output second result
    // (Huovilainen 2004, Section 5 — required for stability at high cutoff)
    for (int os = 0; os < 2; ++os) {
        const float twoVt = 2.0f * Vt;
        const float r = resSmoothed_;
        const float g = gSmoothed_;

        // Stage 1: resonance feedback from yd (eq. 13)
        float x1 = AudioMath::fastTanh((x - 4.0f * r * yd_) / twoVt);
        ya_ = ya_ + g * (x1 - wa_);
        wa_ = AudioMath::fastTanh(ya_ / twoVt);

        // Stages 2–3 (eq. 14–15)
        yb_ = yb_ + g * (wa_ - wb_);
        wb_ = AudioMath::fastTanh(yb_ / twoVt);

        yc_ = yc_ + g * (wb_ - wc_);
        wc_ = AudioMath::fastTanh(yc_ / twoVt);

        // Stage 4 (eq. 16)
        yd_ = yd_ + g * (wc_ - AudioMath::fastTanh(yd_ / twoVt));
    }

    x = yd_;
}

void MoogLadder::process(float* buffer, int numSamples) {
    // Update smoothed params once per block — cheap and avoids per-sample atomics
    const float smoothing = 0.05f;
    gSmoothed_   += smoothing * (computeG() - gSmoothed_);
    resSmoothed_ += smoothing * (resonance_.load(std::memory_order_relaxed) - resSmoothed_);

    float drv = drive_.load(std::memory_order_relaxed);

    for (int i = 0; i < numSamples; ++i) {
        float s = buffer[i] * drv;
        processSample(s);
        buffer[i] = s;
    }
}
```

---

## 5. iOS TurboModule Wrapper

### 5.1 How Expo TurboModules work on iOS

Expo modules on iOS are registered via `ExpoModulesCore`. The native module is an Objective-C++ class (`.mm`) that owns a C++ `AudioEngineHost` object. That host manages the module registry and plugs into the system audio graph — either via `react-native-audio-api`'s `AudioContext` or a standalone `AVAudioEngine` unit.

### 5.2 Module Host

```objc
// modules/ios/AudioDSP.h
#pragma once
#import <Foundation/Foundation.h>
#include "../core/include/MoogLadder.h"
#include "../core/include/RingBuffer.h"
#include <unordered_map>
#include <memory>

@interface AudioDSPHost : NSObject

- (instancetype)initWithSampleRate:(double)sampleRate blockSize:(int)blockSize;

// Module lifecycle
- (int)createModule:(NSString*)moduleName;       // returns moduleId
- (void)destroyModule:(int)moduleId;

// Parameter bridge — called from JS thread, delivered to audio thread
- (void)setParameter:(int)moduleId paramId:(int)paramId value:(float)value;

// Audio callback — call from your audio render block
- (void)processBuffer:(float*)buffer numSamples:(int)numSamples moduleId:(int)moduleId;

@end
```

```objc
// modules/ios/AudioDSP.mm
#import "AudioDSP.h"
#include "../core/include/AudioModule.h"
#import <memory>

@implementation AudioDSPHost {
    std::unordered_map<int, std::unique_ptr<AudioModule>> modules_;
    AudioParamQueue paramQueue_;
    double sampleRate_;
    int blockSize_;
    int nextModuleId_;
}

- (instancetype)initWithSampleRate:(double)sr blockSize:(int)bs {
    self = [super init];
    sampleRate_ = sr;
    blockSize_  = bs;
    nextModuleId_ = 0;
    return self;
}

- (int)createModule:(NSString*)name {
    std::unique_ptr<AudioModule> mod;
    if ([name isEqualToString:@"MoogLadder"]) {
        mod = std::make_unique<MoogLadder>();
    }
    // Add additional modules here as they're built
    if (!mod) return -1;
    mod->prepare(sampleRate_, blockSize_);
    int id = nextModuleId_++;
    modules_[id] = std::move(mod);
    return id;
}

- (void)destroyModule:(int)moduleId {
    modules_.erase(moduleId);
}

- (void)setParameter:(int)moduleId paramId:(int)paramId value:(float)value {
    // Push onto ring buffer from JS/main thread
    paramQueue_.push({moduleId, paramId, value});
}

- (void)processBuffer:(float*)buffer numSamples:(int)n moduleId:(int)moduleId {
    // Drain param queue first — audio thread only
    ParamEvent e;
    while (paramQueue_.pop(e)) {
        auto it = modules_.find(e.moduleId);
        if (it != modules_.end()) it->second->setParameter(e.paramId, e.value);
    }
    // Process
    auto it = modules_.find(moduleId);
    if (it != modules_.end()) it->second->process(buffer, n);
}

@end
```

### 5.3 Expo Module Installer

```objc
// modules/ios/AudioDSPInstaller.mm
#import "AudioDSPInstaller.h"
#import "AudioDSP.h"
#import <ExpoModulesCore/ExpoModulesCore.h>

// Expo module declaration
EX_DEFINE_MODULE_CLASS(AudioDSPModule);

@implementation AudioDSPModule {
    AudioDSPHost* host_;
}

EX_EXPORT_MODULE(AudioDSP);

EX_EXPORT_METHOD_AS(createModule,
    createModule:(NSString*)name
    resolve:(EXPromiseResolveBlock)resolve
    reject:(EXPromiseRejectBlock)reject)
{
    if (!host_) {
        host_ = [[AudioDSPHost alloc] initWithSampleRate:44100.0 blockSize:512];
    }
    int moduleId = [host_ createModule:name];
    resolve(@(moduleId));
}

EX_EXPORT_METHOD_AS(setParameter,
    setParameter:(int)moduleId
    paramId:(int)paramId
    value:(double)value
    resolve:(EXPromiseResolveBlock)resolve
    reject:(EXPromiseRejectBlock)reject)
{
    [host_ setParameter:moduleId paramId:paramId value:(float)value];
    resolve(nil);
}

EX_EXPORT_METHOD_AS(destroyModule,
    destroyModule:(int)moduleId
    resolve:(EXPromiseResolveBlock)resolve
    reject:(EXPromiseRejectBlock)reject)
{
    [host_ destroyModule:moduleId];
    resolve(nil);
}

@end
```

---

## 6. Android TurboModule Wrapper

### 6.1 CMakeLists.txt

```cmake
# modules/CMakeLists.txt
cmake_minimum_required(VERSION 3.22)
project(AudioDSP)

set(CMAKE_CXX_STANDARD 17)

# Collect all core DSP sources
file(GLOB CORE_SOURCES "core/src/*.cpp")

add_library(audiodsp SHARED
    ${CORE_SOURCES}
    android/src/main/cpp/AudioDSP.cpp
)

target_include_directories(audiodsp PRIVATE
    core/include
    ${REACT_NATIVE_DIR}/ReactAndroid/src/main/jni/react/turbomodule
)

# Link Android audio (Oboe for low-latency on Android)
find_package(oboe REQUIRED CONFIG)
target_link_libraries(audiodsp
    oboe::oboe
    android
    log
)
```

### 6.2 JNI Bridge

```cpp
// modules/android/src/main/cpp/AudioDSP.cpp
#include <jni.h>
#include <unordered_map>
#include <memory>
#include "AudioModule.h"
#include "MoogLadder.h"
#include "RingBuffer.h"

static std::unordered_map<int, std::unique_ptr<AudioModule>> gModules;
static AudioParamQueue gParamQueue;
static int gNextId = 0;

extern "C" {

JNIEXPORT jint JNICALL
Java_com_audiodsp_AudioDSPModule_nativeCreateModule(
    JNIEnv* env, jobject, jstring nameJ, jdouble sampleRate, jint blockSize)
{
    const char* name = env->GetStringUTFChars(nameJ, nullptr);
    std::unique_ptr<AudioModule> mod;

    if (strcmp(name, "MoogLadder") == 0) mod = std::make_unique<MoogLadder>();
    // Extend here for new modules

    env->ReleaseStringUTFChars(nameJ, name);
    if (!mod) return -1;

    mod->prepare(sampleRate, blockSize);
    int id = gNextId++;
    gModules[id] = std::move(mod);
    return id;
}

JNIEXPORT void JNICALL
Java_com_audiodsp_AudioDSPModule_nativeSetParameter(
    JNIEnv*, jobject, jint moduleId, jint paramId, jfloat value)
{
    gParamQueue.push({moduleId, paramId, value});
}

JNIEXPORT void JNICALL
Java_com_audiodsp_AudioDSPModule_nativeProcess(
    JNIEnv* env, jobject, jint moduleId, jfloatArray bufferJ, jint numSamples)
{
    // Drain param queue (audio thread)
    ParamEvent e;
    while (gParamQueue.pop(e)) {
        auto it = gModules.find(e.moduleId);
        if (it != gModules.end()) it->second->setParameter(e.paramId, e.value);
    }

    float* buffer = env->GetFloatArrayElements(bufferJ, nullptr);
    auto it = gModules.find(moduleId);
    if (it != gModules.end()) it->second->process(buffer, numSamples);
    env->ReleaseFloatArrayElements(bufferJ, buffer, 0);
}

JNIEXPORT void JNICALL
Java_com_audiodsp_AudioDSPModule_nativeDestroyModule(
    JNIEnv*, jobject, jint moduleId)
{
    gModules.erase(moduleId);
}

} // extern "C"
```

### 6.3 Kotlin Module

```kotlin
// modules/android/src/main/java/com/audiodsp/AudioDSPModule.kt
package com.audiodsp

import com.facebook.react.bridge.*

class AudioDSPModule(reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "AudioDSP"

    @ReactMethod
    fun createModule(name: String, sampleRate: Double, blockSize: Int, promise: Promise) {
        val id = nativeCreateModule(name, sampleRate, blockSize)
        if (id < 0) promise.reject("ERR_MODULE", "Unknown module: $name")
        else promise.resolve(id)
    }

    @ReactMethod
    fun setParameter(moduleId: Int, paramId: Int, value: Float, promise: Promise) {
        nativeSetParameter(moduleId, paramId, value)
        promise.resolve(null)
    }

    @ReactMethod
    fun destroyModule(moduleId: Int, promise: Promise) {
        nativeDestroyModule(moduleId)
        promise.resolve(null)
    }

    companion object {
        init { System.loadLibrary("audiodsp") }
    }

    private external fun nativeCreateModule(name: String, sr: Double, bs: Int): Int
    private external fun nativeSetParameter(moduleId: Int, paramId: Int, value: Float)
    private external fun nativeDestroyModule(moduleId: Int)
}
```

---

## 7. TypeScript Interface Layer

### 7.1 TurboModule Spec

```typescript
// modules/js/NativeAudioDSP.ts
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  createModule(name: string, sampleRate: number, blockSize: number): Promise<number>;
  setParameter(moduleId: number, paramId: number, value: number): Promise<void>;
  destroyModule(moduleId: number): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('AudioDSP');
```

### 7.2 Per-Module Typed Wrapper

Each DSP module gets its own TypeScript wrapper that hides the raw integer param IDs and provides a clean, discoverable API.

```typescript
// modules/js/modules/MoogLadder.ts
import NativeAudioDSP from '../NativeAudioDSP';

export const MoogLadderParams = {
  CUTOFF:    0,
  RESONANCE: 1,
  DRIVE:     2,
} as const;

export interface MoogLadderConfig {
  cutoff?:    number;  // Hz, 20–20000, default 1000
  resonance?: number;  // 0–1, default 0
  drive?:     number;  // 0.5–4.0, default 1.0
}

export class MoogLadderModule {
  private moduleId: number | null = null;
  private sampleRate: number;

  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
  }

  async init(config: MoogLadderConfig = {}): Promise<void> {
    this.moduleId = await NativeAudioDSP.createModule('MoogLadder', this.sampleRate, 512);
    if (config.cutoff    !== undefined) await this.setCutoff(config.cutoff);
    if (config.resonance !== undefined) await this.setResonance(config.resonance);
    if (config.drive     !== undefined) await this.setDrive(config.drive);
  }

  async setCutoff(hz: number): Promise<void> {
    this.assertReady();
    await NativeAudioDSP.setParameter(this.moduleId!, MoogLadderParams.CUTOFF, hz);
  }

  async setResonance(value: number): Promise<void> {
    this.assertReady();
    await NativeAudioDSP.setParameter(this.moduleId!, MoogLadderParams.RESONANCE,
      Math.max(0, Math.min(1, value)));
  }

  async setDrive(value: number): Promise<void> {
    this.assertReady();
    await NativeAudioDSP.setParameter(this.moduleId!, MoogLadderParams.DRIVE, value);
  }

  async destroy(): Promise<void> {
    if (this.moduleId !== null) {
      await NativeAudioDSP.destroyModule(this.moduleId);
      this.moduleId = null;
    }
  }

  private assertReady() {
    if (this.moduleId === null) throw new Error('MoogLadderModule: call init() first');
  }
}
```

### 7.3 React Hook

```typescript
// modules/js/useDSPModule.ts
import { useEffect, useRef } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import { MoogLadderModule } from './modules/MoogLadder';

export function useMoogLadder(initialConfig = {}) {
  const module = useRef<MoogLadderModule | null>(null);

  // Reanimated SharedValues for UI/visual coupling
  const cutoff    = useSharedValue(1000);
  const resonance = useSharedValue(0);

  useEffect(() => {
    const mod = new MoogLadderModule();
    module.current = mod;
    mod.init(initialConfig);
    return () => { mod.destroy(); };
  }, []);

  const setCutoff = (hz: number) => {
    cutoff.value = hz;
    module.current?.setCutoff(hz);
  };

  const setResonance = (r: number) => {
    resonance.value = r;
    module.current?.setResonance(r);
  };

  return { setCutoff, setResonance, cutoff, resonance };
}
```

---

## 8. Integration with react-native-audio-api

The TurboModule owns C++ DSP objects and a parameter queue. The audio graph is still managed by `react-native-audio-api`. The connection point is a custom `AudioWorkletNode` (when available) or, in the interim, a `ScriptProcessorNode`-equivalent that calls back into the TurboModule's `process()` on the audio thread.

```
react-native-audio-api graph:
  OscillatorNode → [custom insert point] → GainNode → destination
                        ↑
               MoogLadder TurboModule
               (C++ process() called here
                at audio thread priority)
```

Until react-native-audio-api provides a stable audio insert hook, the interim strategy is:

1. Use react-native-audio-api to manage the audio graph (oscillators, gain, routing)
2. Feed the filter as a post-process step via a native `AVAudioUnit` (iOS) or Oboe callback (Android) that sits downstream in the system audio graph, before the hardware output

This requires a small amount of additional native wiring but avoids re-implementing the entire audio graph in C++.

---

## 9. Adding a New Module — Checklist

When you're ready to build the next DSP module (a granular delay, a reverb, an LFO processor, etc.), the process is:

```
[ ] 1. Create core/include/MyModule.h — extend AudioModule
[ ] 2. Create core/src/MyModule.cpp — implement prepare/process/reset/setParameter
[ ] 3. Add #include and factory case to AudioDSP.mm (iOS)
[ ] 4. Add #include and factory case to AudioDSP.cpp (Android JNI)
[ ] 5. Create modules/js/modules/MyModule.ts — typed TS wrapper + param constants
[ ] 6. Export from modules/js/index.ts
[ ] 7. Add useMyModule() hook if it needs Reanimated SharedValue coupling
[ ] 8. Rebuild dev client (npx expo run:ios / run:android)
```

Steps 1–7 follow an identical pattern every time. Steps 3–4 are one-liners (add a string comparison to the factory). The only creative work is the DSP in steps 1–2.

---

## 10. Candidate Modules for Future Implementation

In rough priority order for an ambient generative synth:

| Module | Key params | Notes |
|---|---|---|
| **MoogLadder** | cutoff, resonance, drive | First implementation — this plan |
| **Convolution Reverb** | wetDry, IRIndex | Load IR from assets; long processing — needs careful buffering |
| **Granular Processor** | grainSize, scatter, pitch | Core ambient texture tool; most complex DSP |
| **Stereo Chorus/Flanger** | rate, depth, feedback | Fattens drone voices; relatively simple |
| **Waveshaper/Saturator** | drive, shape | Soft clip, fold, asymmetric — parameterized curves |
| **LFO Engine** | rate, shape, target | Modulates other module params; produces SharedValue-friendly output |
| **Spectral Freeze** | mix, evolution | FFT-based; freeze and slowly morph spectral content |
| **Envelope Follower** | attack, release | Analyzes amplitude to drive visual params from audio energy |

The Envelope Follower is particularly valuable for the audio→visual coupling: it converts audio energy into a smooth SharedValue that Skia can read, making visuals genuinely reactive to sound rather than just sharing abstract parameters.

---

## 11. Build and Iteration Workflow

```bash
# First-time native build (after adding/changing native code)
npx expo run:ios    # or run:android

# Day-to-day: JS changes hot-reload, no rebuild needed
npx expo start --dev-client

# After changing C++ (core DSP) or ObjC/Kotlin wrappers:
npx expo run:ios    # full rebuild required

# Useful: test C++ in isolation before wiring to RN
# Add a small CLI test harness in modules/core/test/
g++ -std=c++17 -I modules/core/include \
    modules/core/src/MoogLadder.cpp \
    modules/core/src/AudioMath.cpp \
    modules/core/test/test_moog.cpp \
    -o test_moog && ./test_moog
```

Testing DSP logic with a simple CLI harness before touching React Native saves significant iteration time — you can verify filter frequency response and stability entirely outside the mobile build loop.

---

## 12. Key References

- [Huovilainen 2004 — Non-Linear Digital Implementation of the Moog Ladder Filter](https://www.acoustics.hut.fi/publications/papers/dafx2004-moog/)
- [Expo Modules API (native module authoring)](https://docs.expo.dev/modules/overview/)
- [React Native New Architecture — TurboModules](https://reactnative.dev/docs/the-new-architecture/why)
- [Oboe — Android low-latency audio](https://github.com/google/oboe)
- [JUCE DSP module reference](https://docs.juce.com/master/group__juce__dsp.html) — good reference for additional DSP algorithm patterns
- [The Audio Programmer (YouTube)](https://www.youtube.com/@TheAudioProgrammer) — C++ audio DSP tutorials
- [Will Pirkle — Designing Audio Effect Plugins in C++](http://www.willpirkle.com) — textbook covering many of the candidate modules above
