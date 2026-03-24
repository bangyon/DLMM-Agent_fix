import { Connection } from '@solana/web3.js';
export interface BundlerReport {
    poolAddress: string;
    isSuspicious: boolean;
    suspicionScore: number;
    reasons: string[];
    recentLargeSwaps: number;
    uniqueTradersCount: number;
    topTraderConcentration: number;
}
export declare function checkBundlerActivity(connection: Connection, poolAddress: string): Promise<BundlerReport>;
export declare function formatBundlerReportForAI(report: BundlerReport): string;
//# sourceMappingURL=bundlerChecker.d.ts.map