import { Gesture } from "react-native-gesture-handler";
import type { Params } from "../params/useParams";

/** Clamp `v` to [min, max]. Runs as a worklet. */
function clamp(v: number, min: number, max: number): number {
  "worklet";
  return Math.min(Math.max(v, min), max);
}

/**
 * Builds and returns a composed gesture that maps user touch interactions
 * to the five abstract parameters.
 *
 * Gesture map:
 *   Pan (vertical)     → mood     (swipe up = warmer / more major)
 *   Pan (horizontal)   → density  (swipe right = denser)
 *   Pinch              → brightness (spread = brighter)
 *   Long-press hold    → texture  (held = more texture)
 *   Two-finger swipe   → speed    (up = faster)
 *
 * All handlers run as Reanimated worklets — no JS thread involvement.
 */
export function useGestures(params: Params) {
  // --- Pan: vertical → mood, horizontal → density ---
  const pan = Gesture.Pan()
    .minDistance(4)
    .onUpdate((e) => {
      "worklet";
      // Vertical: swipe up raises mood (negative translationY = up)
      params.mood.value = clamp(
        params.mood.value - e.translationY * 0.0006,
        0,
        1,
      );
      // Horizontal: swipe right raises density
      params.density.value = clamp(
        params.density.value + e.translationX * 0.0005,
        0,
        1,
      );
    });

  // --- Pinch: scale → brightness ---
  const pinch = Gesture.Pinch().onUpdate((e) => {
    "worklet";
    const delta = (e.scale - 1) * 0.15;
    params.brightness.value = clamp(params.brightness.value + delta, 0, 1);
  });

  // --- Two-finger pan: vertical → speed ---
  const twoFingerPan = Gesture.Pan()
    .minPointers(2)
    .maxPointers(2)
    .onUpdate((e) => {
      "worklet";
      params.speed.value = clamp(
        params.speed.value - e.translationY * 0.0005,
        0,
        1,
      );
    });

  // --- Long-press: hold to raise texture, release to lower ---
  const longPress = Gesture.LongPress()
    .minDuration(300)
    .onStart(() => {
      "worklet";
      params.texture.value = clamp(params.texture.value + 0.3, 0, 1);
    })
    .onFinalize(() => {
      "worklet";
      params.texture.value = clamp(params.texture.value - 0.3, 0, 1);
    });

  // Compose: simultaneous allows pinch + pan at the same time
  return Gesture.Simultaneous(
    Gesture.Race(twoFingerPan, pan),
    pinch,
    longPress,
  );
}
