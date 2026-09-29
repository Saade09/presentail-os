import React from "react";
import { Pressable, StyleProp, ViewStyle } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";

interface AnimatedPressButtonProps {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  testID?: string;
  children: React.ReactNode;
}

export function AnimatedPressButton({
  onPress,
  style,
  disabled,
  testID,
  children,
}: AnimatedPressButtonProps) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const handlePress = () => {
    if (disabled) return;
    scale.value = withSequence(
      withTiming(0.96, { duration: 110 }),
      withTiming(1, { duration: 90 }),
    );
    opacity.value = withSequence(
      withTiming(0.65, { duration: 110 }),
      withTiming(1, { duration: 90 }, () => {
        runOnJS(onPress)();
      }),
    );
  };

  return (
    <Pressable testID={testID} onPress={handlePress} disabled={disabled}>
      <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
    </Pressable>
  );
}
