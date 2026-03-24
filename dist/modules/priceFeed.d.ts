export interface TokenMomentum {
    mint: string;
    symbol: string;
    currentPrice: number;
    priceChange1h: number;
    priceChange6h: number;
    priceChange24h: number;
    volume1h: number;
    volume6h: number;
    volume24h: number;
    feeMomentumScore: number;
    trend: 'up' | 'down' | 'sideways';
    liquidityUsd: number;
    marketCap: number;
}
export interface RugCheckResult {
    isSafe: boolean;
    rugScore: number;
    reasons: string[];
    top10HolderPct: number;
    hasFreezable: boolean;
    hasMintable: boolean;
    liquidityLocked: boolean;
}
export declare function getTokenMomentum(mint: string, symbol: string): Promise<TokenMomentum>;
export declare function getMultipleTokenMomentum(tokens: Array<{
    mint: string;
    symbol: string;
}>): Promise<Map<string, TokenMomentum>>;
export declare function checkRug(mint: string): Promise<RugCheckResult>;
export declare function formatMomentumForAI(m: TokenMomentum, rug: RugCheckResult): string;
//# sourceMappingURL=priceFeed.d.ts.map