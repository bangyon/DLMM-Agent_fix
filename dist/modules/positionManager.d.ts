import { Connection, Keypair } from '@solana/web3.js';
import { StrategyType } from '@meteora-ag/dlmm';
import { StrategyDecision } from '../agent/brain';
export interface ActivePosition {
    positionKey: Keypair;
    poolAddress: string;
    poolName: string;
    entryPrice: number;
    solDeposited: number;
    openedAt: Date;
    strategyType: StrategyType;
    binRange: number;
    lastChecked: Date;
}
export interface PositionStatus {
    position: ActivePosition;
    currentValue: number;
    pnlPercent: number;
    feeEarned: number;
    isInRange: boolean;
    activeBinId: number;
    solConvertedToToken: boolean;
    tokenConvertedToSol: boolean;
    totalSolInPosition: number;
    totalTokenInPosition: number;
}
export declare function openPosition(connection: Connection, wallet: Keypair, poolAddress: string, poolName: string, decision: StrategyDecision, solAmount: number): Promise<ActivePosition | null>;
export declare function checkPositionStatus(connection: Connection, wallet: Keypair, position: ActivePosition): Promise<PositionStatus | null>;
export declare function closePosition(connection: Connection, wallet: Keypair, position: ActivePosition): Promise<boolean>;
export declare function formatPositionsForAI(statuses: PositionStatus[]): string;
//# sourceMappingURL=positionManager.d.ts.map