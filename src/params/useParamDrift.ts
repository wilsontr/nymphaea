import { useEffect, useRef } from "react";
import { runOnUI } from "react-native-reanimated";
import type { Params } from "./useParams";

const DRIFT_INTERVAL_MS = 50; // ~20 Hz update rate for drift

/**
 * Clamp a value to [min, max].
 */
function clamp(v: number, min: number, max: number): number {
  "worklet";
  return Math.min(Math.max(v, min), max);
}

/**
 * Slowly drifts all five parameters using independent random walks.
 * The drift runs on the JS thread and writes into SharedValues so
 * both the audio engine (via useAnimatedReaction) and the visual
 * renderer pick up changes automatically.
 */
export function useParamDrift(params: Params): void {
  // Independent phase accumulators for each param's slow LFO
  const phases = useRef({
    density: Math.random() * Math.PI * 2,
    mood: Math.random() * Math.PI * 2,
    brightness: Math.random() * Math.PI * 2,
    speed: Math.random() * Math.PI * 2,
    texture: Math.random() * Math.PI * 2,
  });

  // Per-param random walk "velocity" – changes slowly over time
  const velocities = useRef({
    density: 0,
    mood: 0,
    brightness: 0,
    speed: 0,
    texture: 0,
  });

  useEffect(() => {
    let lastTime = Date.now();

    const tick = () => {
      const now = Date.now();
      const dt = (now - lastTime) / 1000; // seconds
      lastTime = now;

      const ph = phases.current;
      const vel = velocities.current;

      // Advance LFO phases at different rates
      ph.density += dt * 0.07;
      ph.mood += dt * 0.04;
      ph.brightness += dt * 0.05;
      ph.speed += dt * 0.03;
      ph.texture += dt * 0.06;

      // Compute target values from overlapping slow sines
      const targets = {
        density:
          0.5 + 0.3 * Math.sin(ph.density) + 0.15 * Math.sin(ph.density * 2.3),
        mood: 0.5 + 0.35 * Math.sin(ph.mood) + 0.1 * Math.sin(ph.mood * 1.7),
        brightness:
          0.5 +
          0.25 * Math.sin(ph.brightness) +
          0.15 * Math.sin(ph.brightness * 3.1),
        speed: 0.4 + 0.2 * Math.sin(ph.speed) + 0.1 * Math.sin(ph.speed * 2.7),
        texture:
          0.3 + 0.25 * Math.sin(ph.texture) + 0.15 * Math.sin(ph.texture * 1.9),
      };

      // Smooth toward targets with exponential slew (lazy follow)
      const alpha = 1 - Math.exp(-dt * 0.8);

      vel.density += (targets.density - vel.density) * alpha;
      vel.mood += (targets.mood - vel.mood) * alpha;
      vel.brightness += (targets.brightness - vel.brightness) * alpha;
      vel.speed += (targets.speed - vel.speed) * alpha;
      vel.texture += (targets.texture - vel.texture) * alpha;

      // Write into shared values on the UI thread
      const newDensity = clamp(vel.density, 0, 1);
      const newMood = clamp(vel.mood, 0, 1);
      const newBrightness = clamp(vel.brightness, 0, 1);
      const newSpeed = clamp(vel.speed, 0, 1);
      const newTexture = clamp(vel.texture, 0, 1);

      runOnUI(() => {
        "worklet";
        params.density.value = newDensity;
        params.mood.value = newMood;
        params.brightness.value = newBrightness;
        params.speed.value = newSpeed;
        params.texture.value = newTexture;
      })();
    };

    const id = setInterval(tick, DRIFT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [params]);
}
