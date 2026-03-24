export interface Lesson {
    id: number;
    rule: string;
    tags: string[];
    outcome: 'good' | 'bad' | 'neutral' | 'manual';
    pnlPct: number;
    rangeEfficiency: number;
    poolName: string;
    createdAt: string;
}
export interface PositionPerformance {
    pool: string;
    poolName: string;
    strategy: string;
    binRange: number;
    binStep: number;
    organicScore: number;
    holders: number;
    marketCap: number;
    feeActiveTvlRatio: number;
    solDeposited: number;
    feesEarnedSol: number;
    finalValueSol: number;
    initialValueSol: number;
    minutesInRange: number;
    minutesHeld: number;
    closeReason: string;
}
export declare function recordPerformance(perf: PositionPerformance): Promise<void>;
export declare function getLessonsForPrompt(maxLessons?: number): string;
export declare function getPerformanceSummary(): string;
//# sourceMappingURL=lessons.d.ts.map