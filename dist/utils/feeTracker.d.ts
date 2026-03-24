import { Connection, Keypair } from '@solana/web3.js';
import { ActivePosition } from '../modules/positionManager';
export interface FeeRecord {
    timestamp: string;
    poolName: string;
    poolAddress: string;
    feeXAmount: number;
    feeYAmount: number;
    feeUsd: number;
    txSignature: string;
}
export interface CompoundStats {
    totalFeeClaimed: number;
    totalFeeUsd: number;
    claimCount: number;
    lastClaimAt: string | null;
    positions: Record<string, {
        totalFee: number;
        claimCount: number;
    }>;
}
export declare function claimFees(connection: Connection, wallet: Keypair, position: ActivePosition): Promise<FeeRecord | null>;
export declare function getCompoundStats(): CompoundStats;
export declare function printFeeReport(): void;
//# sourceMappingURL=feeTracker.d.ts.map