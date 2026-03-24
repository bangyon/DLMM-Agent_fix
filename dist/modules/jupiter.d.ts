import { Connection, Keypair } from '@solana/web3.js';
export interface TokenPrice {
    mint: string;
    symbol: string;
    priceUsd: number;
    change24h: number;
    volume24h: number;
}
export interface VolatilityData {
    symbol: string;
    priceChangePercent: number;
    volatilityScore: number;
    recommendation: 'Spot' | 'Curve' | 'BidAsk';
    suggestedBinRange: number;
}
export declare function getTokenPrice(mint: string): Promise<number>;
export declare function getTokenPrices(mints: string[]): Promise<Record<string, number>>;
export declare function analyzeVolatility(tokenMint: string, tokenSymbol: string, binStep: number): Promise<VolatilityData>;
export declare function swapSolToToken(connection: Connection, wallet: Keypair, outputMint: string, solAmountLamports: number, slippageBps?: number): Promise<string | null>;
export declare function getWalletBalances(connection: Connection, walletAddress: string, tokenMints: string[]): Promise<{
    sol: number;
    tokens: Record<string, number>;
}>;
export declare function formatVolatilityForAI(data: VolatilityData): string;
//# sourceMappingURL=jupiter.d.ts.map