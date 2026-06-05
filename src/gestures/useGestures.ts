import { Gesture } from "react-native-gesture-handler";
import type { SharedValue } from "react-native-reanimated";
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
export function useGestures(
  params: Params,
  isInteracting: SharedValue<number>,
) {
  const beginInteraction = () => {
    "worklet";
    isInteracting.value += 1;
  };

  const endInteraction = () => {
    "worklet";
    isInteracting.value = Math.max(0, isInteracting.value - 1);
  };

  // --- Pan: vertical → mood, horizontal → density ---
  const panStart = { mood: 0, density: 0 };
  const pan = Gesture.Pan()
    .minDistance(4)
    .onBegin(beginInteraction)
    .onStart(() => {
      "worklet";
      panStart.mood = params.mood.value;
      panStart.density = params.density.value;
    })
    .onUpdate((e) => {
      "worklet";
      // Vertical: swipe up raises mood (negative translationY = up)
      params.mood.value = clamp(panStart.mood - e.translationY * 0.0006, 0, 1);
      // Horizontal: swipe right raises density
      params.density.value = clamp(
        panStart.density + e.translationX * 0.0005,
        0,
        1,
      );
    })
    .onFinalize(endInteraction);

  // --- Pinch: scale → brightness ---
  const pinchStart = { brightness: 0 };
  const pinch = Gesture.Pinch()
    .onBegin(beginInteraction)
    .onStart(() => {
      "worklet";
      pinchStart.brightness = params.brightness.value;
    })
    .onUpdate((e) => {
      "worklet";
      const delta = (e.scale - 1) * 0.25;
      params.brightness.value = clamp(pinchStart.brightness + delta, 0, 1);
    })
    .onFinalize(endInteraction);

  // --- Two-finger pan: vertical → speed ---
  const twoFingerStart = { speed: 0 };
  const twoFingerPan = Gesture.Pan()
    .minPointers(2)
    .maxPointers(2)
    .onBegin(beginInteraction)
    .onStart(() => {
      "worklet";
      twoFingerStart.speed = params.speed.value;
    })
    .onUpdate((e) => {
      "worklet";
      params.speed.value = clamp(
        twoFingerStart.speed - e.translationY * 0.0005,
        0,
        1,
      );
    })
    .onFinalize(endInteraction);

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
