export interface BacktestConfig {
    poolAddress: string;
    poolName: string;
    strategyType: 'Spot' | 'Curve' | 'BidAsk';
    binRange: number;
    initialSol: number;
    daysBack: number;
}
export interface BacktestResult {
    config: BacktestConfig;
    totalDays: number;
    hoursInRange: number;
    hoursOutRange: number;
    inRangePercent: number;
    totalFeeEarned: number;
    feeApr: number;
    estimatedIL: number;
    netReturn: number;
    bestBinRange: number;
    verdict: 'excellent' | 'good' | 'mediocre' | 'poor';
    summary: string;
    dataSource: 'live' | 'mock';
}
export declare function runBacktest(config: BacktestConfig): Promise<BacktestResult>;
export declare function comparePoolBacktests(pools: Array<{
    address: string;
    name: string;
    binStep: number;
}>, daysBack?: number): Promise<BacktestResult[]>;
//# sourceMappingURL=simulator.d.ts.map