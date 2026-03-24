export declare class DLMMAgent {
    private connection;
    private wallet;
    private activePositions;
    private isRunning;
    private cycleCount;
    private telegram;
    private tracker;
    private pools;
    private lastPoolFetchAt;
    private flipTargetPool;
    private flipTargetName;
    private stream;
    private recentlyClosedPools;
    private outOfRangeRightSince;
    private tokenSidePositions;
    constructor();
    runBacktestMode(daysBack?: number): Promise<void>;
    start(): Promise<void>;
    stop(): void;
    private cycle;
    private managePositions;
    private close;
    private findAndEnter;
    private evaluatePool;
    private buildEntryPrompt;
    private reopenTokenSide;
    private buildTokenSideCompletePrompt;
    private buildClosePrompt;
}
//# sourceMappingURL=orchestrator.d.ts.map