import { useEffect, useRef, useCallback } from "react";
import { useAnimatedReaction } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { AudioEngine } from "./AudioEngine";
import type { Params } from "../params/useParams";

/**
 * Initialises the AudioEngine on mount, tears it down on unmount,
 * and wires the five Reanimated SharedValues to their audio counterparts
 * via useAnimatedReaction.
 */
export function useAudioEngine(params: Params): void {
  const engineRef = useRef<AudioEngine | null>(null);

  // Create the engine once
  useEffect(() => {
    const engine = new AudioEngine();
    engineRef.current = engine;
    engine.start();
    return () => {
      engine.stop();
      engineRef.current = null;
    };
  }, []);

  // Stable JS-scope callbacks for runOnJS — inline lambdas inside
  // useAnimatedReaction cause a JSI assertion crash because the worklet
  // runtime calls getHostFunction on a non-host jsi::Function.
  const updateMood = useCallback(
    (v: number) => engineRef.current?.setMood(v),
    [],
  );
  const updateBrightness = useCallback(
    (v: number) => engineRef.current?.setBrightness(v),
    [],
  );
  const updateTexture = useCallback(
    (v: number) => engineRef.current?.setTexture(v),
    [],
  );
  const updateSpeed = useCallback(
    (v: number) => engineRef.current?.setSpeed(v),
    [],
  );
  const updateDensity = useCallback(
    (v: number) => engineRef.current?.setDensity(v),
    [],
  );

  // Bridge: SharedValue changes → audio parameter updates
  useAnimatedReaction(
    () => params.mood.value,
    (current) => {
      scheduleOnRN(updateMood, current);
    },
  );

  useAnimatedReaction(
    () => params.brightness.value,
    (current) => {
      scheduleOnRN(updateBrightness, current);
    },
  );

  useAnimatedReaction(
    () => params.texture.value,
    (current) => {
      scheduleOnRN(updateTexture, current);
    },
  );

  useAnimatedReaction(
    () => params.speed.value,
    (current) => {
      scheduleOnRN(updateSpeed, current);
    },
  );

  useAnimatedReaction(
    () => params.density.value,
    (current) => {
      scheduleOnRN(updateDensity, current);
    },
  );
}
