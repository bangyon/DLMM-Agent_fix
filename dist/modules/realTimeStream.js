"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealTimeStream = void 0;
const config_1 = require("../config");
const poolFinder_1 = require("./poolFinder");
const priceFeed_1 = require("./priceFeed");
const lpAgent_1 = require("./lpAgent");
const INTERVALS = {
    pools: 30000, // Meteora pools: 30 detik
    momentum: 60000, // DexScreener momentum: 1 menit
    lpAgent: 120000, // LP Agent signals: 2 menit
};
// Hot pool detection thresholds
const HOT_DETECT = {
    minVolTvlRatio: 10,
    minApr: 100,
    minMomentumScore: 40,
};
class RealTimeStream {
    constructor(topWallets = []) {
        this.state = {
            pools: [],
            momentum: new Map(),
            lpAgentSignals: [],
            lastPoolFetch: 0,
            lastMomentumFetch: 0,
            lastLPAgentFetch: 0,
            isReady: false,
        };
        this.handlers = [];
        this.timers = [];
        this.isRunning = false;
        this.previousHotPools = new Set();
        this.topWallets = topWallets;
    }
    onEvent(handler) {
        this.handlers.push(handler);
    }
    async emit(event) {
        for (const handler of this.handlers) {
            try {
                await handler(event);
            }
            catch { }
        }
    }
    async start() {
        this.isRunning = true;
        console.log('\n📡 Real-time stream dimulai...');
        console.log(`   Meteora: setiap ${INTERVALS.pools / 1000}s`);
        console.log(`   DexScreener: setiap ${INTERVALS.momentum / 1000}s`);
        console.log(`   LP Agent: setiap ${INTERVALS.lpAgent / 1000}s`);
        // Initial fetch semua data
        await this.fetchPools();
        await this.fetchMomentum();
        if (config_1.CONFIG.ai.lpAgentApiKey)
            await this.fetchLPAgent();
        this.state.isReady = true;
        // Start polling loops
        this.timers.push(setInterval(() => this.fetchPools(), INTERVALS.pools), setInterval(() => this.fetchMomentum(), INTERVALS.momentum));
        if (config_1.CONFIG.ai.lpAgentApiKey) {
            this.timers.push(setInterval(() => this.fetchLPAgent(), INTERVALS.lpAgent));
        }
    }
    stop() {
        this.isRunning = false;
        for (const t of this.timers)
            clearInterval(t);
        this.timers = [];
        console.log('📡 Real-time stream dihentikan');
    }
    getState() {
        return this.state;
    }
    async fetchPools() {
        if (!this.isRunning)
            return;
        try {
            const pools = await (0, poolFinder_1.getTopPools)(30);
            this.state.pools = pools;
            this.state.lastPoolFetch = Date.now();
            await this.emit({ type: 'pools_updated', pools });
            // Deteksi hot pool baru yang belum pernah terdeteksi
            for (const pool of pools) {
                const isHot = pool.volumeTvlRatio >= HOT_DETECT.minVolTvlRatio &&
                    pool.feeApr24h >= HOT_DETECT.minApr;
                if (isHot && !this.previousHotPools.has(pool.address)) {
                    this.previousHotPools.add(pool.address);
                    const reason = `Vol/TVL ${pool.volumeTvlRatio.toFixed(1)}x | APR ${pool.feeApr24h.toFixed(0)}%`;
                    await this.emit({ type: 'hot_pool_detected', pool, reason });
                }
            }
            // Cleanup pool dari set jika sudah tidak hot
            const currentAddresses = new Set(pools.map(p => p.address));
            for (const addr of this.previousHotPools) {
                if (!currentAddresses.has(addr))
                    this.previousHotPools.delete(addr);
            }
        }
        catch (err) {
            await this.emit({ type: 'error', source: 'meteora', message: String(err) });
        }
    }
    async fetchMomentum() {
        if (!this.isRunning || this.state.pools.length === 0)
            return;
        try {
            const topPools = this.state.pools.slice(0, 8);
            const tokens = topPools.map(p => ({
                mint: p.tokenX.mint,
                symbol: p.tokenX.symbol,
            }));
            const momentum = await (0, priceFeed_1.getMultipleTokenMomentum)(tokens);
            this.state.momentum = momentum;
            this.state.lastMomentumFetch = Date.now();
            await this.emit({ type: 'momentum_updated', data: momentum });
            // Price alert jika ada token yang bergerak > 10% dalam 1 jam
            for (const [mint, m] of momentum) {
                if (Math.abs(m.priceChange1h) > 10) {
                    await this.emit({ type: 'price_alert', mint, changePercent: m.priceChange1h });
                }
            }
        }
        catch (err) {
            await this.emit({ type: 'error', source: 'dexscreener', message: String(err) });
        }
    }
    async fetchLPAgent() {
        if (!this.isRunning || !config_1.CONFIG.ai.lpAgentApiKey)
            return;
        try {
            const signals = await (0, lpAgent_1.getLPAgentSignals)(this.topWallets, config_1.CONFIG.ai.lpAgentApiKey);
            this.state.lpAgentSignals = signals;
            this.state.lastLPAgentFetch = Date.now();
            await this.emit({ type: 'lpagent_updated', signals });
        }
        catch (err) {
            await this.emit({ type: 'error', source: 'lpagent', message: String(err) });
        }
    }
}
exports.RealTimeStream = RealTimeStream;
//# sourceMappingURL=realTimeStream.js.map