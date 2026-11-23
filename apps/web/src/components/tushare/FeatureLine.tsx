import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import { chartAxisValue, chartPalette } from '../../chartTheme'

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

export default function FeatureLine({ dates, values, unit, label }: {
  dates: string[]; values: (number | null)[]; unit: string; label: string
}) {
  const option = {
    animation: false, color: [chartPalette.primary], textStyle: { fontFamily: chartPalette.fontFamily },
    grid: { top: 32, left: 53, right: 14, bottom: 30, containLabel: false },
    tooltip: { trigger: 'axis', renderMode: 'richText', textStyle: { color: chartPalette.text } },
    xAxis: { type: 'time', boundaryGap: false, axisLabel: { color: chartPalette.muted, hideOverlap: true, formatter: '{MM}-{dd}' },
      axisLine: { lineStyle: { color: chartPalette.grid } } },
    yAxis: { type: 'value', name: unit, scale: true, splitNumber: 4,
      nameTextStyle: { color: chartPalette.muted }, axisLabel: { color: chartPalette.muted, formatter: chartAxisValue },
      splitLine: { lineStyle: { color: chartPalette.grid } } },
    series: [{ type: 'line', name: label, data: dates.map((date, index) => [date, values[index]]),
      showSymbol: dates.length <= 24, symbolSize: 5, lineStyle: { width: 2 } }],
  }
  return <div className="tushare-line" role="img" aria-label={label + ' · ' + dates[0] + ' 至 ' + dates.at(-1) + ' · ' + unit}>
    <ReactEChartsCore echarts={echarts} option={option} notMerge style={{ width: '100%', height: 220 }} />
  </div>
}
