import { PoolInfo } from './poolFinder';
import { TokenMomentum } from './priceFeed';
import { LPAgentSignal } from './lpAgent';
export interface StreamState {
    pools: PoolInfo[];
    momentum: Map<string, TokenMomentum>;
    lpAgentSignals: LPAgentSignal[];
    lastPoolFetch: number;
    lastMomentumFetch: number;
    lastLPAgentFetch: number;
    isReady: boolean;
}
export type StreamEvent = {
    type: 'pools_updated';
    pools: PoolInfo[];
} | {
    type: 'momentum_updated';
    data: Map<string, TokenMomentum>;
} | {
    type: 'lpagent_updated';
    signals: LPAgentSignal[];
} | {
    type: 'hot_pool_detected';
    pool: PoolInfo;
    reason: string;
} | {
    type: 'price_alert';
    mint: string;
    changePercent: number;
} | {
    type: 'error';
    source: string;
    message: string;
};
export type EventHandler = (event: StreamEvent) => Promise<void>;
export declare class RealTimeStream {
    private state;
    private handlers;
    private timers;
    private isRunning;
    private previousHotPools;
    private topWallets;
    constructor(topWallets?: string[]);
    onEvent(handler: EventHandler): void;
    private emit;
    start(): Promise<void>;
    stop(): void;
    getState(): StreamState;
    private fetchPools;
    private fetchMomentum;
    private fetchLPAgent;
}
//# sourceMappingURL=realTimeStream.d.ts.map