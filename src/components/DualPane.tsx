/**
 * DualPane — tablet-landscape two-up layout (v1.5).
 *
 * Renders two portrait-shaped columns side by side so a tablet user can run two
 * tools at once. Gated entirely behind `isDualPaneEligible` in App.tsx; phones
 * and portrait never reach this component, so the single-screen split shipped
 * earlier is completely untouched.
 *
 * Why each column is wrapped in its own single-screen navigator:
 *   TunerScreen + MetroScreen call `useFocusEffect` at the top of their bodies,
 *   which calls `useNavigation()` under the hood and THROWS when rendered
 *   outside a navigator. A pane therefore cannot be a bare `<TunerScreen/>`.
 *   We give each column a one-screen `createBottomTabNavigator` (tab bar nulled
 *   out) purely to supply the navigation context `useFocusEffect` needs — it
 *   adds NO new dependency (bottom-tabs is already used by the main shell) and
 *   no visible chrome.
 *
 * react-navigation v7 (this repo: @react-navigation/native 7.2.5) REMOVED the
 * `independent` prop that v6 required on a nested NavigationContainer; v7
 * supports nested containers out of the box, so we pass no such prop. Each pane
 * uses a DISTINCT module-scope navigator + its own NavigationContainer instance
 * so the two panes' navigation states stay fully isolated from each other and
 * from the App's outer NavigationContainer.
 */
import React from 'react';
import { View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

// Two distinct navigators — one per column — created at module scope per the
// react-navigation pattern. Each pane needs its own navigation context; reusing
// a single navigator object across both columns would have them fight over one
// state tree, so we keep them separate.
const LeftPaneNav = createBottomTabNavigator();
const RightPaneNav = createBottomTabNavigator();

export interface DualPaneProps {
  /** Renders the LEFT pane's content (already orientation-overridden by caller). */
  left: () => React.ReactElement;
  /** Renders the RIGHT pane's content (already orientation-overridden by caller). */
  right: () => React.ReactElement;
  /** Hairline divider colour — passed from the theme palette (e.g. C.edge). */
  dividerColor: string;
}

export function DualPane({ left, right, dividerColor }: DualPaneProps) {
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ flex: 1 }}>
        <NavigationContainer>
          <LeftPaneNav.Navigator
            screenOptions={{ headerShown: false }}
            tabBar={() => null}
          >
            <LeftPaneNav.Screen name="pane">{left}</LeftPaneNav.Screen>
          </LeftPaneNav.Navigator>
        </NavigationContainer>
      </View>
      {/* 1px hairline divider between the two panes. */}
      <View style={{ width: 1, backgroundColor: dividerColor }} />
      <View style={{ flex: 1 }}>
        <NavigationContainer>
          <RightPaneNav.Navigator
            screenOptions={{ headerShown: false }}
            tabBar={() => null}
          >
            <RightPaneNav.Screen name="pane">{right}</RightPaneNav.Screen>
          </RightPaneNav.Navigator>
        </NavigationContainer>
      </View>
    </View>
  );
}
