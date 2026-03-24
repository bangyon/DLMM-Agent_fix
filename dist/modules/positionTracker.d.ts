import { ActivePosition } from './positionManager';
export interface PositionTrack {
    position: ActivePosition;
    openPrice: number;
    highestPrice: number;
    lastRebalanceAt: Date;
    hoursHeld: number;
    feeAccumulated: number;
    rebalanceCount: number;
}
export declare class PositionTracker {
    private tracks;
    addPosition(position: ActivePosition, currentPrice: number): void;
    removePosition(positionKey: string): void;
    updateTrack(positionKey: string, currentPrice: number, feeEarned: number): void;
    shouldClose(positionKey: string, currentPrice: number, pnlPercent: number): {
        should: boolean;
        reason: string;
    };
    shouldRebalance(positionKey: string, isOutOfRange: boolean): {
        should: boolean;
        reason: string;
    };
    markRebalanced(positionKey: string): void;
    getTrack(positionKey: string): PositionTrack | undefined;
    getSummary(): string;
}
//# sourceMappingURL=positionTracker.d.ts.map