import React, { useMemo } from "react";
import { Platform, StyleSheet, useWindowDimensions } from "react-native";
import { Canvas, Fill, Shader, Skia } from "@shopify/react-native-skia";
import {
  useFrameCallback,
  useSharedValue,
  useDerivedValue,
} from "react-native-reanimated";
import { FLOW_FIELD_SHADER } from "./shaders/flowField";
import type { Params } from "../params/useParams";

interface AmbientCanvasProps {
  params: Params;
}

/**
 * Full-screen Skia canvas that renders the procedural ambient visual.
 *
 * Architecture:
 *  - Compiles the SkSL shader once on mount.
 *  - `useFrameCallback` ticks a `time` SharedValue on the UI thread at 60fps.
 *  - `useDerivedValue` assembles the uniforms object from all SharedValues;
 *    Skia reads this directly on the UI thread — no JS bridge per frame.
 */
export function AmbientCanvas({
  params,
}: AmbientCanvasProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();

  // Keep resolution in SharedValues so the worklet sees rotation updates
  // without needing to re-create the useDerivedValue closure.
  const resolutionWidth = useSharedValue(width);
  const resolutionHeight = useSharedValue(height);
  resolutionWidth.value = width;
  resolutionHeight.value = height;

  // Compile the shader once
  const effect = useMemo(() => {
    const e = Skia.RuntimeEffect.Make(FLOW_FIELD_SHADER);
    if (!e) {
      console.error("AmbientCanvas: Failed to compile SkSL shader");
    }
    return e;
  }, []);

  // Time advances every frame on the UI thread.
  // In the simulator, throttle to 15fps to avoid janky shader rendering
  // caused by the simulator's software Metal emulation.
  const TARGET_FRAME_MS = Platform.isTV || __DEV__ ? 1000 / 15 : 0;
  const time = useSharedValue(0);
  const lastFrameTime = useSharedValue(-1);

  useFrameCallback((info) => {
    "worklet";
    const now = info.timestamp;
    if (TARGET_FRAME_MS > 0 && now - lastFrameTime.value < TARGET_FRAME_MS) {
      return;
    }
    lastFrameTime.value = now;
    const dt = (info.timeSincePreviousFrame ?? 16) / 1000;
    time.value += dt * (0.3 + params.speed.value * 1.4);
  });

  // Assemble uniforms from SharedValues — runs on UI thread via useDerivedValue
  const uniforms = useDerivedValue(() => ({
    time: time.value,
    density: params.density.value,
    mood: params.mood.value,
    brightness: params.brightness.value,
    texture: params.texture.value,
    resolution: [resolutionWidth.value, resolutionHeight.value] as [
      number,
      number,
    ],
  }));

  if (!effect) {
    return <></>;
  }

  return (
    <Canvas style={styles.canvas}>
      <Fill>
        <Shader source={effect} uniforms={uniforms} />
      </Fill>
    </Canvas>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    width: "100%",
    height: "100%",
  },
});
