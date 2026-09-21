import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import MapView, { Marker, Polyline } from 'react-native-maps';

import type { WalkMapHandle, WalkMapProps } from './WalkMap';

export const WalkMap = forwardRef<WalkMapHandle, WalkMapProps>(function WalkMap(
  { segments, style, showUserLocation = false },
  forwardedRef,
) {
  const mapRef = useRef<MapView>(null);
  const points = segments.flat();

  useImperativeHandle(forwardedRef, () => ({
    captureSnapshot: async () => {
      if (!mapRef.current) return null;
      return mapRef.current.takeSnapshot({
        width: 1000,
        height: 620,
        format: 'png',
        quality: 1,
        result: 'file',
      });
    },
  }), []);

  useEffect(() => {
    if (points.length < 2) return;
    const timer = setTimeout(() => {
      mapRef.current?.fitToCoordinates(points, {
        edgePadding: { top: 70, right: 55, bottom: 70, left: 55 },
        animated: true,
      });
    }, 160);
    return () => clearTimeout(timer);
  }, [segments]);

  const first = points[0];
  const last = points.at(-1);
  const region = last ? {
    latitude: last.latitude,
    longitude: last.longitude,
    latitudeDelta: 0.008,
    longitudeDelta: 0.008,
  } : {
    latitude: 25.033,
    longitude: 121.5654,
    latitudeDelta: 0.08,
    longitudeDelta: 0.08,
  };

  return (
    <MapView
      ref={mapRef}
      style={style}
      initialRegion={region}
      showsUserLocation={showUserLocation}
      showsMyLocationButton={false}
      showsCompass={false}
      toolbarEnabled={false}
    >
      {segments.map((segment, index) => segment.length > 1 ? (
        <Polyline key={`walk-segment-${index}`} coordinates={segment} strokeColor="#1F684D" strokeWidth={6} lineCap="round" lineJoin="round" />
      ) : null)}
      {first ? <Marker coordinate={first} title="起點" pinColor="#7E9188" /> : null}
      {last && points.length > 1 ? <Marker coordinate={last} title="目前位置" pinColor="#1F684D" /> : null}
    </MapView>
  );
});
