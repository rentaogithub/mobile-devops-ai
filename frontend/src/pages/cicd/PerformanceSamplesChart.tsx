import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import { Empty, Space, Tag, Typography } from 'antd';
import { JenkinsQualityPerformanceSamples } from '../../services/api';
import { QualityReportKind } from './qualityOptions';

const { Text } = Typography;

interface PerformanceSamplesChartProps {
  data: JenkinsQualityPerformanceSamples;
  reportKind?: QualityReportKind;
  formatSeconds: (value?: number | null) => string;
}

export function PerformanceSamplesChart({
  data,
  reportKind = 'generic',
  formatSeconds,
}: PerformanceSamplesChartProps) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const includeFps = reportKind !== 'monkey';
  const hasMetric = data.samples.some((sample) => sample.cpu !== null || sample.memoryMB !== null || (includeFps && sample.fps !== null));
  const validCpuSamples = data.samples.filter((sample) => sample.cpu !== null);
  const validMemorySamples = data.samples.filter((sample) => sample.memoryMB !== null);
  const validFpsSamples = data.samples.filter((sample) => sample.fps !== null);
  const hasCpuSamples = validCpuSamples.length > 0;
  const hasMemorySamples = validMemorySamples.length > 0;
  const hasFpsSamples = includeFps && validFpsSamples.length > 0;
  const maxCpuSample = validCpuSamples.reduce<typeof validCpuSamples[number] | null>(
    (max, sample) => (!max || Number(sample.cpu) > Number(max.cpu) ? sample : max),
    null
  );
  const maxMemorySample = validMemorySamples.reduce<typeof validMemorySamples[number] | null>(
    (max, sample) => (!max || Number(sample.memoryMB) > Number(max.memoryMB) ? sample : max),
    null
  );
  const minFpsSample = validFpsSamples.reduce<typeof validFpsSamples[number] | null>(
    (min, sample) => (!min || Number(sample.fps) < Number(min.fps) ? sample : min),
    null
  );

  useEffect(() => {
    if (!chartRef.current || !hasMetric) return;
    const chart = echarts.init(chartRef.current);
    const labels = data.samples.map((sample) => `${Math.round(sample.timeSeconds || 0)}s`);
    const sampleLabel = (sample?: JenkinsQualityPerformanceSamples['samples'][number] | null) => {
      if (!sample) return '';
      const position = data.samples.findIndex((item) => item.index === sample.index);
      return labels[position >= 0 ? position : 0] || '';
    };
    const markPointStyle = {
      symbolSize: 48,
      label: { fontSize: 10 },
    };
    const legendItems = [
      hasCpuSamples ? 'CPU %' : '',
      hasMemorySamples ? '内存 MB' : '',
      includeFps && hasFpsSamples ? 'FPS' : '',
    ].filter(Boolean);
    const series: echarts.EChartsOption['series'] = [
      hasCpuSamples ? {
        name: 'CPU %',
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        data: data.samples.map((sample) => sample.cpu),
        markPoint: maxCpuSample ? {
          ...markPointStyle,
          data: [{ name: 'CPU 峰值', coord: [sampleLabel(maxCpuSample), Number(maxCpuSample.cpu)], value: Number(maxCpuSample.cpu) }],
        } : undefined,
      } : null,
      hasMemorySamples ? {
        name: '内存 MB',
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        yAxisIndex: 1,
        data: data.samples.map((sample) => sample.memoryMB),
        markPoint: maxMemorySample ? {
          ...markPointStyle,
          data: [{ name: '内存峰值', coord: [sampleLabel(maxMemorySample), Number(maxMemorySample.memoryMB)], value: Number(maxMemorySample.memoryMB) }],
        } : undefined,
      } : null,
      includeFps && hasFpsSamples ? {
        name: 'FPS',
        type: 'line',
        showSymbol: false,
        connectNulls: true,
        data: data.samples.map((sample) => sample.fps),
        markPoint: minFpsSample ? {
          ...markPointStyle,
          data: [{ name: 'FPS 低点', coord: [sampleLabel(minFpsSample), Number(minFpsSample.fps)], value: Number(minFpsSample.fps) }],
        } : undefined,
      } : null,
    ].filter(Boolean) as echarts.EChartsOption['series'];
    const option: echarts.EChartsOption = {
      color: ['#1677ff', '#52c41a', '#fa8c16'],
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any) => {
          const list = Array.isArray(params) ? params : [params];
          const first = list[0];
          const sample = data.samples[first?.dataIndex || 0];
          const lines = [
            `时间：${formatSeconds(Math.round(sample?.timeSeconds || 0))} / 样本 #${sample?.index ?? '-'}`,
            ...list.map((item: any) => `${item.marker || ''}${item.seriesName}: ${item.value === null || item.value === undefined ? '-' : item.value}`),
          ];
          return lines.join('<br/>');
        },
      },
      legend: {
        top: 0,
        data: legendItems,
      },
      grid: {
        top: 48,
        left: 48,
        right: 56,
        bottom: 40,
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: labels,
        axisLabel: {
          formatter: (value: string) => value,
        },
      },
      yAxis: [
        {
          type: 'value',
          name: includeFps ? 'CPU/FPS' : 'CPU',
          min: 0,
          axisLabel: { formatter: '{value}' },
        },
        {
          type: 'value',
          name: '内存 MB',
          min: 0,
          position: 'right',
          axisLabel: { formatter: '{value}' },
        },
      ],
      dataZoom: [
        { type: 'inside' },
        { type: 'slider', height: 18, bottom: 8 },
      ],
      series,
    };
    chart.setOption(option);
    const resize = () => chart.resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      chart.dispose();
    };
  }, [data, hasMetric, hasCpuSamples, hasMemorySamples, hasFpsSamples, includeFps, maxCpuSample, maxMemorySample, minFpsSample, formatSeconds]);

  if (!data.sampleCount || !hasMetric) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未采集到性能样本" />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {reportKind !== 'monkey' && (
        <>
          <Space wrap>
            <Tag>采样 {data.sampleCount} 条</Tag>
            {data.samples.length > 0 && <Tag>覆盖 {formatSeconds(Math.round(Math.max(...data.samples.map((sample) => sample.timeSeconds || 0))))}</Tag>}
            {data.summary.cpu.avg !== null && <Tag>CPU 平均 {data.summary.cpu.avg}% / 峰值 {data.summary.cpu.max ?? '-'}%</Tag>}
            {data.summary.memoryMB.avg !== null && <Tag>内存平均 {data.summary.memoryMB.avg}MB / 峰值 {data.summary.memoryMB.max ?? '-'}MB</Tag>}
            {includeFps && data.summary.fps.avg !== null && <Tag>FPS 平均 {data.summary.fps.avg} / 最低 {data.summary.fps.min ?? '-'}</Tag>}
            {includeFps && data.summary.fps.avg === null && <Tag color="gold">FPS 未采集</Tag>}
            {includeFps && <Tag color="gold">帧级卡顿未采集</Tag>}
            {(data.truncated || data.sourceTruncated) && <Tag color="orange">已截断</Tag>}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            横轴为采样时间，图中标记已采集指标的峰值；可拖动底部滑块放大某段执行过程。
          </Text>
        </>
      )}
      <div ref={chartRef} style={{ width: '100%', height: 360 }} />
    </Space>
  );
}
