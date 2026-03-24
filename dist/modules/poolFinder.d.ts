export interface PoolInfo {
    address: string;
    name: string;
    tokenX: {
        mint: string;
        symbol: string;
        decimals: number;
    };
    tokenY: {
        mint: string;
        symbol: string;
        decimals: number;
    };
    binStep: number;
    feeRate: number;
    tvl: number;
    activeTvl: number;
    volume: number;
    feeWindow: number;
    feeActiveTvlRatio: number;
    volatility: number;
    organicScore: number;
    holders: number;
    marketCapUsd: number;
    priceTrend: number[];
    priceChangePct: number;
    uniqueTraders: number;
    swapCount: number;
    warnings: number;
    activePositions: number;
    volumeTvlRatio: number;
    compositeScore: number;
    tier: 'hot' | 'warm' | 'cold';
    strategy: MemeStrategy;
    maxHoldHours: number;
    binRangeHint: number;
    poolAgeHours: number;
    feeApr24h: number;
    feeMomentumScore: number;
}
export type MemeStrategy = 'spot_pump' | 'spot_dump' | 'bidask_flip' | 'skip';
declare function detectStrategy(p: any, organic: number, feeRatio: number): {
    strategy: MemeStrategy;
    maxHoldHours: number;
    binRangeHint: number;
};
export declare function getTopPools(limit?: number): Promise<PoolInfo[]>;
export declare function rankPools(pools: PoolInfo[]): PoolInfo[];
export declare function getSolAllocationMultiplier(pool: PoolInfo): number;
export declare function formatPoolsForAI(pools: PoolInfo[]): string;
export { detectStrategy };
//# sourceMappingURL=poolFinder.d.ts.map