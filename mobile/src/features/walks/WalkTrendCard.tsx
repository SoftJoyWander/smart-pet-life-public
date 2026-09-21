import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import type { WalkSessionRow } from '../../types/database';

export type WalkTrendRange = 7 | 30;

type WalkMetric = 'distance' | 'duration' | 'count' | 'speed';

type DailyWalkSummary = {
  date: string;
  label: string;
  distanceM: number;
  durationSeconds: number;
  count: number;
};

type MetricConfig = {
  label: string;
  unit: string;
  decimals: number;
  value: (summary: DailyWalkSummary) => number;
};

const metricConfigs: Record<WalkMetric, MetricConfig> = {
  distance: {
    label: '距離',
    unit: 'km',
    decimals: 1,
    value: (summary) => summary.distanceM / 1000,
  },
  duration: {
    label: '時間',
    unit: '分',
    decimals: 0,
    value: (summary) => summary.durationSeconds / 60,
  },
  count: {
    label: '次數',
    unit: '次',
    decimals: 0,
    value: (summary) => summary.count,
  },
  speed: {
    label: '速度',
    unit: 'km/h',
    decimals: 1,
    value: (summary) => summary.durationSeconds > 0
      ? (summary.distanceM / summary.durationSeconds) * 3.6
      : 0,
  },
};

const metrics = Object.keys(metricConfigs) as WalkMetric[];

function parseDateValue(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatDateValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateAtOffset(date: Date, offset: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

function emptySummary(date: Date): DailyWalkSummary {
  return {
    date: formatDateValue(date),
    label: `${date.getMonth() + 1}/${date.getDate()}`,
    distanceM: 0,
    durationSeconds: 0,
    count: 0,
  };
}

function buildWalkSummaryMap(walks: WalkSessionRow[]) {
  const summaries = new Map<string, DailyWalkSummary>();
  walks.forEach((walk) => {
    const startedAt = new Date(walk.started_at);
    if (Number.isNaN(startedAt.getTime())) return;
    const date = formatDateValue(startedAt);
    const summary = summaries.get(date) ?? emptySummary(startedAt);
    summary.distanceM += Math.max(0, walk.distance_m ?? 0);
    summary.durationSeconds += Math.max(0, walk.duration_seconds ?? 0);
    summary.count += 1;
    summaries.set(date, summary);
  });
  return summaries;
}

function summariesForPeriod(summaryMap: Map<string, DailyWalkSummary>, endDate: Date, range: WalkTrendRange) {
  return Array.from({ length: range }, (_, index) => {
    const date = dateAtOffset(endDate, index - range + 1);
    return summaryMap.get(formatDateValue(date)) ?? emptySummary(date);
  });
}

function combineSummaries(summaries: DailyWalkSummary[]): DailyWalkSummary {
  return summaries.reduce<DailyWalkSummary>((total, summary) => ({
    ...total,
    distanceM: total.distanceM + summary.distanceM,
    durationSeconds: total.durationSeconds + summary.durationSeconds,
    count: total.count + summary.count,
  }), emptySummary(new Date()));
}

function formatDuration(totalSeconds: number) {
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} 分`;
  if (minutes === 0) return `${hours} 小時`;
  return `${hours} 小時 ${minutes} 分`;
}

function formatMetricValue(value: number, config: MetricConfig) {
  return value.toFixed(config.decimals);
}

function WalkTrendChart({
  days,
  summaryMap,
  metric,
}: {
  days: DailyWalkSummary[];
  summaryMap: Map<string, DailyWalkSummary>;
  metric: WalkMetric;
}) {
  const config = metricConfigs[metric];
  const chartWidth = 360;
  const chartHeight = 176;
  const left = 39;
  const right = 9;
  const top = 16;
  const bottom = 29;
  const plotWidth = chartWidth - left - right;
  const plotHeight = chartHeight - top - bottom;
  const values = days.map(config.value);
  const rollingValues = days.map((day) => {
    const date = parseDateValue(day.date);
    const window = Array.from({ length: 7 }, (_, index) => {
      const target = dateAtOffset(date, index - 6);
      return summaryMap.get(formatDateValue(target)) ?? emptySummary(target);
    });
    if (metric === 'speed') return config.value(combineSummaries(window));
    return window.reduce((total, item) => total + config.value(item), 0) / 7;
  });
  const maximum = Math.max(...values, ...rollingValues, 1);
  const slotWidth = plotWidth / days.length;
  const barWidth = Math.max(3, Math.min(23, slotWidth * 0.58));
  const linePoints = rollingValues.map((value, index) => ({
    x: left + index * slotWidth + slotWidth / 2,
    y: top + plotHeight - (value / maximum) * plotHeight,
  }));
  const tickIndexes = days.length === 7 ? [0, 3, 6] : [0, 14, 29];
  const total = combineSummaries(days);
  const accessibleValue = metric === 'speed'
    ? config.value(total)
    : values.reduce((sum, value) => sum + value, 0);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`近 ${days.length} 天遛狗${config.label}圖表，已記錄${formatMetricValue(accessibleValue, config)} ${config.unit}。淺綠柱為每日${config.label}，橙線為 7 日平均。`}
      style={styles.chartFrame}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${chartWidth} ${chartHeight}`}>
        {[0, 0.5, 1].map((position) => {
          const y = top + plotHeight * position;
          return <Line key={position} x1={left} x2={chartWidth - right} y1={y} y2={y} stroke="rgba(255,255,255,0.14)" strokeWidth={1} />;
        })}
        <SvgText x={left - 6} y={top + 4} fill="#C5D8CF" fontSize={9} textAnchor="end">
          {formatMetricValue(maximum, config)}
        </SvgText>
        <SvgText x={left - 6} y={top + plotHeight + 3} fill="#C5D8CF" fontSize={9} textAnchor="end">0</SvgText>
        <SvgText x={3} y={top - 5} fill="#C5D8CF" fontSize={8}>{config.unit}</SvgText>
        {values.map((value, index) => {
          const height = value > 0 ? Math.max(2, (value / maximum) * plotHeight) : 0;
          const x = left + index * slotWidth + (slotWidth - barWidth) / 2;
          return height > 0 ? (
            <Rect
              key={days[index].date}
              x={x}
              y={top + plotHeight - height}
              width={barWidth}
              height={height}
              rx={Math.min(4, barWidth / 2)}
              fill="#BDE3CB"
            />
          ) : null;
        })}
        <Polyline
          points={linePoints.map((point) => `${point.x},${point.y}`).join(' ')}
          fill="none"
          stroke="#FF956D"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {days.length === 7 ? linePoints.map((point, index) => (
          <Circle key={days[index].date} cx={point.x} cy={point.y} r={3.1} fill="#FF956D" />
        )) : null}
        {tickIndexes.map((index) => (
          <SvgText
            key={days[index].date}
            x={left + index * slotWidth + slotWidth / 2}
            y={chartHeight - 7}
            fill="#C5D8CF"
            fontSize={9}
            textAnchor="middle"
          >
            {days[index].label}
          </SvgText>
        ))}
      </Svg>
    </View>
  );
}

export function WalkTrendCard({
  walks,
  endDate,
  range,
  onRangeChange,
}: {
  walks: WalkSessionRow[];
  endDate: string;
  range: WalkTrendRange;
  onRangeChange: (range: WalkTrendRange) => void;
}) {
  const [metric, setMetric] = useState<WalkMetric>('distance');
  const summaryMap = useMemo(() => buildWalkSummaryMap(walks), [walks]);
  const end = useMemo(() => parseDateValue(endDate), [endDate]);
  const days = useMemo(() => summariesForPeriod(summaryMap, end, range), [end, range, summaryMap]);
  const previousEnd = useMemo(() => dateAtOffset(end, -range), [end, range]);
  const previousDays = useMemo(
    () => summariesForPeriod(summaryMap, previousEnd, range),
    [previousEnd, range, summaryMap],
  );
  const total = combineSummaries(days);
  const previousTotal = combineSummaries(previousDays);
  const config = metricConfigs[metric];
  const currentValue = config.value(total);
  const previousValue = config.value(previousTotal);
  const difference = currentValue - previousValue;
  const distanceKm = total.distanceM / 1000;
  const averageDistanceKm = total.count > 0 ? distanceKm / total.count : 0;
  const comparisonThreshold = metric === 'count' ? 0.5 : 0.05;

  let insight = `近 ${range} 天沒有遛狗紀錄，資料不足以判斷趨勢。`;
  if (total.count > 0) {
    const prefix = metric === 'speed'
      ? `近 ${range} 天平均速度 ${formatMetricValue(currentValue, config)} ${config.unit}`
      : `近 ${range} 天共 ${formatMetricValue(currentValue, config)} ${config.unit}`;
    if (Math.abs(difference) < comparisonThreshold) {
      insight = `${prefix}，與前 ${range} 天大致相同。`;
    } else {
      insight = `${prefix}，較前 ${range} 天${difference > 0 ? '增加' : '減少'} ${formatMetricValue(Math.abs(difference), config)} ${config.unit}。`;
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.kicker}>GPS 記錄摘要</Text>
          <Text style={styles.title}>遛狗趨勢・近 {range} 天</Text>
        </View>
        <View style={styles.rangeControl}>
          {([7, 30] as WalkTrendRange[]).map((value) => (
            <TouchableOpacity
              key={value}
              accessibilityRole="button"
              accessibilityState={{ selected: range === value }}
              accessibilityLabel={`查看近 ${value} 天遛狗趨勢`}
              style={[styles.rangeButton, range === value && styles.controlActive]}
              onPress={() => onRangeChange(value)}
            >
              <Text style={[styles.controlText, range === value && styles.controlTextActive]}>{value} 天</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={styles.summaryGrid}>
        <SummaryItem label="總距離" value={`${distanceKm.toFixed(1)} km`} />
        <SummaryItem label="總時間" value={formatDuration(total.durationSeconds)} />
        <SummaryItem label="遛狗" value={`${total.count} 次`} />
        <SummaryItem label="平均每次" value={`${averageDistanceKm.toFixed(1)} km`} />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.metricControl}
        accessibilityRole="tablist"
      >
        {metrics.map((value) => (
          <TouchableOpacity
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: metric === value }}
            style={[styles.metricButton, metric === value && styles.controlActive]}
            onPress={() => setMetric(value)}
          >
            <Text style={[styles.controlText, metric === value && styles.controlTextActive]}>{metricConfigs[value].label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.legend}>
        <View style={styles.legendItem}><View style={styles.legendBar} /><Text style={styles.legendText}>每日{config.label}</Text></View>
        <View style={styles.legendItem}><View style={styles.legendLine} /><Text style={styles.legendText}>7 日平均</Text></View>
      </View>
      <WalkTrendChart days={days} summaryMap={summaryMap} metric={metric} />

      <View style={styles.insightRow}>
        <Text style={styles.insightIcon}>↗</Text>
        <Text style={styles.insightText}>{insight}</Text>
      </View>
      <Text style={styles.disclaimer}>僅反映 App 已記錄的遛狗活動；沒有紀錄不代表沒有活動。</Text>
    </View>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryItem}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text adjustsFontSizeToFit numberOfLines={1} style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#173F31', borderRadius: 23, padding: '4.5%', marginBottom: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14 },
  heading: { flex: 1, minWidth: 0 },
  kicker: { color: '#AFC7BB', fontSize: 9, fontWeight: '800' },
  title: { color: '#FFFFFF', fontSize: 16, fontWeight: '900', marginTop: 3 },
  rangeControl: { flexDirection: 'row', flexShrink: 0, backgroundColor: 'rgba(255,255,255,0.09)', borderRadius: 11, padding: 3 },
  rangeButton: { minHeight: 32, minWidth: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 9, paddingHorizontal: 8 },
  controlActive: { backgroundColor: '#FFF7EE' },
  controlText: { color: '#BCD1C6', fontSize: 10, fontWeight: '900' },
  controlTextActive: { color: '#173F31' },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4, marginBottom: 12 },
  summaryItem: { flexGrow: 1, flexBasis: '46%', minWidth: 120, paddingHorizontal: 10, paddingVertical: 9, margin: 4, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.07)' },
  summaryLabel: { color: '#AFC7BB', fontSize: 9, fontWeight: '800' },
  summaryValue: { color: '#FFFFFF', fontSize: 17, fontWeight: '900', marginTop: 4, fontVariant: ['tabular-nums'] },
  metricControl: { minWidth: '100%', flexGrow: 1, flexDirection: 'row', padding: 3, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.09)', marginBottom: 12 },
  metricButton: { flexGrow: 1, minWidth: 68, minHeight: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 9, paddingHorizontal: 10 },
  legend: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 16, marginBottom: 2 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendBar: { width: 12, height: 12, borderRadius: 3, backgroundColor: '#BDE3CB' },
  legendLine: { width: 18, height: 3, borderRadius: 2, backgroundColor: '#FF956D' },
  legendText: { color: '#D6E4DD', fontSize: 9, fontWeight: '800' },
  chartFrame: { width: '100%', aspectRatio: 2.05 },
  insightRow: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 13, padding: 11, marginTop: 5 },
  insightIcon: { width: 22, height: 22, borderRadius: 11, textAlign: 'center', textAlignVertical: 'center', color: '#173F31', backgroundColor: '#FFE0CC', fontSize: 12, fontWeight: '900', marginRight: 8 },
  insightText: { flex: 1, color: '#FFFFFF', fontSize: 10, lineHeight: 16 },
  disclaimer: { color: '#9DB9AC', fontSize: 8, lineHeight: 12, marginTop: 9 },
});
