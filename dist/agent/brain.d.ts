export interface AIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface StrategyDecision {
    action: 'open_position' | 'close_position' | 'rebalance' | 'hold' | 'skip';
    poolAddress?: string;
    strategyType?: string;
    binRange?: number;
    reasoning: string;
    riskLevel: 'low' | 'medium' | 'high';
    confidence: number;
    groqAnalysis?: string;
    claudeVerdict?: string;
}
export declare function askAI(userPrompt: string): Promise<StrategyDecision>;
//# sourceMappingURL=brain.d.ts.map