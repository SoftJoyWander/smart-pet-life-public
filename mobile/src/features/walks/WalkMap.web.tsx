import { forwardRef, useImperativeHandle } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import type { WalkMapHandle, WalkMapProps } from './WalkMap';

export const WalkMap = forwardRef<WalkMapHandle, WalkMapProps>(function WalkMap({ segments, style }, forwardedRef) {
  useImperativeHandle(forwardedRef, () => ({ captureSnapshot: async () => null }), []);
  const points = segments.flat();
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const latitudeMin = Math.min(...latitudes, 0);
  const latitudeMax = Math.max(...latitudes, 0);
  const longitudeMin = Math.min(...longitudes, 0);
  const longitudeMax = Math.max(...longitudes, 0);
  const xRange = Math.max(longitudeMax - longitudeMin, 0.0001);
  const yRange = Math.max(latitudeMax - latitudeMin, 0.0001);
  const chartSegments = segments.map((segment) => segment.map((point) => {
    const x = 18 + ((point.longitude - longitudeMin) / xRange) * 264;
    const y = 162 - ((point.latitude - latitudeMin) / yRange) * 144;
    return `${x},${y}`;
  }).join(' '));
  const firstChartPoint = chartSegments.find((segment) => segment)?.split(' ')[0];

  return (
    <View style={[styles.container, style]}>
      <View style={styles.gridOne} />
      <View style={styles.gridTwo} />
      {points.length > 0 ? (
        <Svg width="100%" height="100%" viewBox="0 0 300 180">
          {chartSegments.map((segment, index) => segment ? (
            <Polyline key={`walk-segment-${index}`} points={segment} fill="none" stroke="#1F684D" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          ) : null)}
          <Circle cx={firstChartPoint?.split(',')[0] ?? 18} cy={firstChartPoint?.split(',')[1] ?? 162} r="6" fill="#7E9188" />
        </Svg>
      ) : <Text style={styles.empty}>取得定位後，路線會顯示在這裡</Text>}
      <View style={styles.webBadge}><Text style={styles.webBadgeText}>網頁路線示意</Text></View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { backgroundColor: '#E8EFEA', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  gridOne: { position: 'absolute', width: '120%', height: 1, backgroundColor: '#D0DDD5', transform: [{ rotate: '18deg' }] },
  gridTwo: { position: 'absolute', width: 1, height: '140%', backgroundColor: '#D0DDD5', transform: [{ rotate: '24deg' }] },
  empty: { color: '#667870', fontSize: 13 },
  webBadge: { position: 'absolute', top: 10, right: 10, backgroundColor: 'rgba(255,255,255,0.9)', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 12 },
  webBadgeText: { color: '#486057', fontSize: 11, fontWeight: '700' },
});
