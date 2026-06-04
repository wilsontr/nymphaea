import { useSharedValue } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";

export interface Params {
  density: SharedValue<number>;
  mood: SharedValue<number>;
  brightness: SharedValue<number>;
  speed: SharedValue<number>;
  texture: SharedValue<number>;
}

/**
 * Creates and returns the five abstract parameter SharedValues that drive
 * both the audio engine and the visual renderer.
 *
 * All values live on [0, 1].
 */
export function useParams(): Params {
  const density = useSharedValue(0.5);
  const mood = useSharedValue(0.3);
  const brightness = useSharedValue(0.6);
  const speed = useSharedValue(0.4);
  const texture = useSharedValue(0.3);

  return { density, mood, brightness, speed, texture };
}
