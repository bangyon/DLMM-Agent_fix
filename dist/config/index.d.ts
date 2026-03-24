export declare const CONFIG: {
    wallet: {
        privateKey: string;
    };
    rpc: {
        url: string;
    };
    ai: {
        provider: "openrouter" | "groq" | "anthropic";
        model: string;
        openrouterKey: string;
        groqKey: string;
        anthropicKey: string;
        lpAgentApiKey: string;
        duneApiKey: string;
    };
    agent: {
        solPerPosition: number;
        maxPositions: number;
        checkIntervalSeconds: number;
        minFeeApr: number;
        maxLossPercent: number;
        defaultBinRange: number;
    };
    jupiter: {
        apiUrl: string;
    };
    meteora: {
        apiUrl: string;
    };
};
export declare function validateConfig(): void;
//# sourceMappingURL=index.d.ts.map