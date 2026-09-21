import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { WalkCoordinate } from './types';

export type WalkMapHandle = {
  captureSnapshot: () => Promise<string | null>;
};

export type WalkMapProps = {
  segments: WalkCoordinate[][];
  style?: StyleProp<ViewStyle>;
  showUserLocation?: boolean;
};

export const WalkMap: ForwardRefExoticComponent<WalkMapProps & RefAttributes<WalkMapHandle>>;
