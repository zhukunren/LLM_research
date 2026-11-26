import type { ComponentProps } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'

export default function WorkspaceChart(props: Omit<ComponentProps<typeof ReactEChartsCore>, 'echarts'>) {
  return <ReactEChartsCore echarts={echarts} {...props} />
}
