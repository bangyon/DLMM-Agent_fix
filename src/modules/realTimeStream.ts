import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config';
import { PoolInfo, getTopPools } from './poolFinder';
import { TokenMomentum, getMultipleTokenMomentum } from './priceFeed';
import { LPAgentSignal, getLPAgentSignals } from './lpAgent';

export interface StreamState {
  pools: PoolInfo[];
  momentum: Map<string, TokenMomentum>;
  lpAgentSignals: LPAgentSignal[];
  lastPoolFetch: number;
  lastMomentumFetch: number;
  lastLPAgentFetch: number;
  isReady: boolean;
}

export type StreamEvent =
  | { type: 'pools_updated'; pools: PoolInfo[] }
  | { type: 'momentum_updated'; data: Map<string, TokenMomentum> }
  | { type: 'lpagent_updated'; signals: LPAgentSignal[] }
  | { type: 'hot_pool_detected'; pool: PoolInfo; reason: string }
  | { type: 'price_alert'; mint: string; changePercent: number }
  | { type: 'error'; source: string; message: string };

export type EventHandler = (event: StreamEvent) => Promise<void>;

const INTERVALS = {
  pools:     30_000,   // Meteora pools: 30 detik
  momentum:  60_000,   // DexScreener momentum: 1 menit
  lpAgent:   120_000,  // LP Agent signals: 2 menit
};

// Hot pool detection thresholds
const HOT_DETECT = {
  minVolTvlRatio: 10,
  minApr: 100,
  minMomentumScore: 40,
};

export class RealTimeStream {
  private state: StreamState = {
    pools: [],
    momentum: new Map(),
    lpAgentSignals: [],
    lastPoolFetch: 0,
    lastMomentumFetch: 0,
    lastLPAgentFetch: 0,
    isReady: false,
  };

  private handlers: EventHandler[] = [];
  private timers: NodeJS.Timeout[] = [];
  private isRunning = false;
  private previousHotPools = new Set<string>();
  private topWallets: string[];

  constructor(topWallets: string[] = []) {
    this.topWallets = topWallets;
  }

  onEvent(handler: EventHandler) {
    this.handlers.push(handler);
  }

  private async emit(event: StreamEvent) {
    for (const handler of this.handlers) {
      try { await handler(event); } catch {}
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
    if (CONFIG.ai.lpAgentApiKey) await this.fetchLPAgent();
    this.state.isReady = true;

    // Start polling loops
    this.timers.push(
      setInterval(() => this.fetchPools(), INTERVALS.pools),
      setInterval(() => this.fetchMomentum(), INTERVALS.momentum),
    );

    if (CONFIG.ai.lpAgentApiKey) {
      this.timers.push(
        setInterval(() => this.fetchLPAgent(), INTERVALS.lpAgent)
      );
    }
  }

  stop() {
    this.isRunning = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    console.log('📡 Real-time stream dihentikan');
  }

  getState(): StreamState {
    return this.state;
  }

  private async fetchPools() {
    if (!this.isRunning) return;
    try {
      const pools = await getTopPools(30);
      this.state.pools = pools;
      this.state.lastPoolFetch = Date.now();
      await this.emit({ type: 'pools_updated', pools });

      // Deteksi hot pool baru yang belum pernah terdeteksi
      for (const pool of pools) {
        const isHot =
          pool.volumeTvlRatio >= HOT_DETECT.minVolTvlRatio &&
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
        if (!currentAddresses.has(addr)) this.previousHotPools.delete(addr);
      }
    } catch (err) {
      await this.emit({ type: 'error', source: 'meteora', message: String(err) });
    }
  }

  private async fetchMomentum() {
    if (!this.isRunning || this.state.pools.length === 0) return;
    try {
      const topPools = this.state.pools.slice(0, 8);
      const tokens = topPools.map(p => ({
        mint: p.tokenX.mint,
        symbol: p.tokenX.symbol,
      }));

      const momentum = await getMultipleTokenMomentum(tokens);
      this.state.momentum = momentum;
      this.state.lastMomentumFetch = Date.now();
      await this.emit({ type: 'momentum_updated', data: momentum });

      // Price alert jika ada token yang bergerak > 10% dalam 1 jam
      for (const [mint, m] of momentum) {
        if (Math.abs(m.priceChange1h) > 10) {
          await this.emit({ type: 'price_alert', mint, changePercent: m.priceChange1h });
        }
      }
    } catch (err) {
      await this.emit({ type: 'error', source: 'dexscreener', message: String(err) });
    }
  }

  private async fetchLPAgent() {
    if (!this.isRunning || !CONFIG.ai.lpAgentApiKey) return;
    try {
      const signals = await getLPAgentSignals(this.topWallets, CONFIG.ai.lpAgentApiKey);
      this.state.lpAgentSignals = signals;
      this.state.lastLPAgentFetch = Date.now();
      await this.emit({ type: 'lpagent_updated', signals });
    } catch (err) {
      await this.emit({ type: 'error', source: 'lpagent', message: String(err) });
    }
  }
}
