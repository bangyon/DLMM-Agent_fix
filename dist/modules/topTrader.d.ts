export declare const GMGN_TOP_WALLETS: Record<string, {
    winRate: number;
    pnl: number;
    positions: number;
    fees: number;
}>;
export declare const TOP_TRADER_WALLETS: string[];
export interface TraderPosition {
    wallet: string;
    walletLabel: string;
    pool: string;
    pairName: string;
    strategyType: string;
    inRange: boolean;
    pnlPercent: number;
    ageHours: number;
    dprNative: number;
    binRange: number;
    currentValue: number;
    inputValue: number;
    collectedFeeNative: number;
    traderWinRate: number;
    traderPnl: number;
}
export interface PoolConsensus {
    pool: string;
    pairName: string;
    traderCount: number;
    traders: string[];
    positions: TraderPosition[];
    dominantStrategy: string;
    avgBinRange: number;
    avgPnlPercent: number;
    avgDpr: number;
    totalValueUsd: number;
    consensusScore: number;
    signal: 'strong_entry' | 'entry' | 'watch' | 'avoid';
    traderExiting: number;
    weightedScore: number;
}
export interface TraderIntelligence {
    pools: Map<string, PoolConsensus>;
    topPools: PoolConsensus[];
    activeTraderCount: number;
    totalPositions: number;
    lastFetched: Date;
    patterns: {
        avgHoldHours: number;
        preferredStrategy: string;
        avgBinRange: number;
        winRate: number;
    };
}
export declare function buildTraderIntelligence(apiKey: string): Promise<TraderIntelligence>;
export declare function getPoolConsensus(intel: TraderIntelligence, pool: string): PoolConsensus | null;
export declare function detectExitSignals(intel: TraderIntelligence, pool: string): {
    isExiting: boolean;
    reason: string;
};
export declare function formatIntelligenceForAI(intel: TraderIntelligence): string;
//# sourceMappingURL=topTrader.d.ts.map