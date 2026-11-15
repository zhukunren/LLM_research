export type StockSignalMarker = { date: string; side: 'buy' | 'sell'; label?: string }
export type StockSignalContext = { side: 'buy' | 'sell'; markers: StockSignalMarker[]; strategyTitle: string }
