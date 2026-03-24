import { ActivePosition, PositionStatus } from '../modules/positionManager';
import { StrategyDecision } from '../agent/brain';
import { PoolInfo } from '../modules/poolFinder';
export declare class TelegramAlert {
    private botToken;
    private chatId;
    private enabled;
    private pendingCallback;
    private pollOffset;
    private isPolling;
    constructor();
    send(text: string, parseMode?: 'HTML' | 'Markdown', extra?: any): Promise<any>;
    private answerCallback;
    private startPolling;
    askPoolSelection(pools: PoolInfo[], aiDecision: StrategyDecision, solBalance: number): Promise<number>;
    alertPoolScan(pools: PoolInfo[], cycle: number): Promise<void>;
    alertAgentStart(walletAddress: string, solBalance: number): Promise<void>;
    alertPositionOpened(position: ActivePosition, decision: StrategyDecision): Promise<void>;
    alertPositionClosed(position: ActivePosition, pnlPercent: number, feeEarned: number, reason: string): Promise<void>;
    alertOutOfRange(position: ActivePosition, pnlPercent: number): Promise<void>;
    alertHighBundlerRisk(poolName: string, poolAddress: string, score: number, reasons: string[]): Promise<void>;
    alertCycleSummary(cycle: number, positions: PositionStatus[], solBalance: number): Promise<void>;
    alertError(message: string, context?: string): Promise<void>;
    alertInfo(message: string): Promise<void>;
}
//# sourceMappingURL=telegram.d.ts.map