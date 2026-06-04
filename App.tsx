import React from "react";
import { StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  GestureHandlerRootView,
  GestureDetector,
} from "react-native-gesture-handler";

import { useParams } from "./src/params/useParams";
import { useParamDrift } from "./src/params/useParamDrift";
import { useAudioEngine } from "./src/audio/useAudioEngine";
import { AmbientCanvas } from "./src/visuals/AmbientCanvas";
import { useGestures } from "./src/gestures/useGestures";

/**
 * Root screen — no navigation, no transport controls.
 * The experience starts on launch and evolves continuously.
 */
export default function App() {
  // Shared parameter bus
  const params = useParams();

  // Autonomous drift keeps parameters evolving without user input
  useParamDrift(params);

  // Audio engine — initialised once, driven by params
  useAudioEngine(params);

  // Gesture → param mapping
  const gesture = useGestures(params);

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar style="light" hidden />
      <GestureDetector gesture={gesture}>
        <View style={styles.root}>
          <AmbientCanvas params={params} />
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },
});
