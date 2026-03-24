import http from 'http';
export interface DashboardState {
    wallet: string;
    solBalance: number;
    activePositions: any[];
    cycleCount: number;
    lastCycleAt: string;
    isRunning: boolean;
    feeStats: any;
    topPools?: any[];
    lastScanAt?: string;
}
export declare function updateDashboardState(partial: Partial<DashboardState>): void;
export declare function startDashboard(port?: number): http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
//# sourceMappingURL=server.d.ts.map