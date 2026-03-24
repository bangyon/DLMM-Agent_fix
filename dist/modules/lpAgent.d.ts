export interface LPAgentPosition {
    owner: string;
    pool: string;
    pairName: string;
    strategyType: string;
    inRange: boolean;
    currentValue: number;
    inputValue: number;
    collectedFeeNative: number;
    pnlPercent: number;
    pnlNative: number;
    dprNative: number;
    age: string;
    tickLower: number;
    tickUpper: number;
    token0: string;
    token1: string;
}
export interface SmartLPTrader {
    wallet: string;
    label: string;
    totalPnlSol: number;
    winRate: number;
    openPositions: LPAgentPosition[];
    preferredPools: string[];
    avgBinRange: number;
    preferredStrategy: string;
}
export interface LPAgentSignal {
    pool: string;
    pairName: string;
    traderCount: number;
    traders: SmartLPTrader[];
    consensusScore: number;
    avgStrategyType: string;
    avgTickRange: number;
    signal: 'strong_entry' | 'entry' | 'neutral' | 'avoid';
    totalValueInPool: number;
}
export declare function getLPAgentPositions(walletAddress: string, apiKey: string): Promise<LPAgentPosition[]>;
export declare function getLPAgentHistory(walletAddress: string, apiKey: string, limit?: number): Promise<any[]>;
export declare function getLPAgentSignals(topWallets: string[], apiKey: string): Promise<LPAgentSignal[]>;
export declare function formatLPAgentSignalForAI(signals: LPAgentSignal[]): string;
//# sourceMappingURL=lpAgent.d.ts.map