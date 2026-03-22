import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from '../config';
import { askAI } from './brain';
import { getTopPools, rankPools, formatPoolsForAI, getSolAllocationMultiplier, PoolInfo } from '../modules/poolFinder';
import { checkBundlerActivity, formatBundlerReportForAI } from '../modules/bundlerChecker';
import { openPosition, checkPositionStatus, closePosition, ActivePosition, PositionStatus } from '../modules/positionManager';
import { analyzeVolatility, formatVolatilityForAI } from '../modules/jupiter';
import { TelegramAlert } from '../alerts/telegram';
import { claimFees } from '../utils/feeTracker';
import { startDashboard, updateDashboardState } from '../dashboard/server';
import { comparePoolBacktests } from '../backtest/simulator';
import { getTokenMomentum, checkRug, formatMomentumForAI } from '../modules/priceFeed';
import { PositionTracker } from '../modules/positionTracker';
// topTrader intel disabled — fokus ke pool filter dari artikel LP Army

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export class DLMMAgent {
  private connection: Connection;
  private wallet: Keypair;
  private activePositions: ActivePosition[] = [];
  private isRunning = false;
  private cycleCount = 0;
  private telegram: TelegramAlert;
  private tracker: PositionTracker;
  

  private lastPoolFetchAt = 0;
  private pools: PoolInfo[] = [];

  constructor() {
    this.connection = new Connection(CONFIG.rpc.url, 'confirmed');
    this.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.wallet.privateKey));
    this.telegram = new TelegramAlert();
    this.tracker = new PositionTracker();
    console.log(`\n🤖 DLMM Agent — wallet: ${this.wallet.publicKey.toBase58()}`);
    console.log(`   AI: ${CONFIG.ai.provider} + Claude | SOL/pos: ${CONFIG.agent.solPerPosition} | max: ${CONFIG.agent.maxPositions}`);
  }

  async runBacktestMode(daysBack = 7) {
    const pools = await getTopPools(10);
    const top = rankPools(pools).slice(0, 3).map(p => ({ address: p.address, name: p.name, binStep: p.binStep }));
    await comparePoolBacktests(top, daysBack);
  }

  async start() {
    startDashboard(parseInt(process.env.DASHBOARD_PORT || '3000'));
    this.isRunning = true;
    console.log('\n🚀 Agent berjalan...\n');
    const sol = await this.connection.getBalance(this.wallet.publicKey) / LAMPORTS_PER_SOL;
    await this.telegram.alertAgentStart(this.wallet.publicKey.toBase58(), sol);

    while (this.isRunning) {
      try { await this.cycle(); }
      catch (err) {
        console.error('❌ Cycle error:', err);
        await this.telegram.alertError('Cycle error', String(err));
      }
      await sleep(CONFIG.agent.checkIntervalSeconds * 1000);
    }
  }

  stop() { this.isRunning = false; this.stream?.stop?.(); console.log('🛑 Stopped'); }
  private stream: any = null; // placeholder

  private async cycle() {
    this.cycleCount++;
    const now = new Date().toLocaleString('id-ID');
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`🔄 Cycle #${this.cycleCount} — ${now}`);

    const solBal = await this.connection.getBalance(this.wallet.publicKey) / LAMPORTS_PER_SOL;
    console.log(`💰 ${solBal.toFixed(4)} SOL | Posisi: ${this.activePositions.length}/${CONFIG.agent.maxPositions}`);

    // 1. Refresh pool list setiap 30 detik
    if (Date.now() - this.lastPoolFetchAt > 30_000) {
      this.pools = await getTopPools(30);
      this.lastPoolFetchAt = Date.now();
    }

    // 3. Monitor & manage posisi aktif
    await this.managePositions();

    // 4. Cari & buka posisi baru
    const slots = CONFIG.agent.maxPositions - this.activePositions.length;
    const hasFunds = solBal >= CONFIG.agent.solPerPosition + 0.02;
    if (slots > 0 && hasFunds) {
      await this.findAndEnter(solBal);
    }

    // Update dashboard
    updateDashboardState({
      wallet: this.wallet.publicKey.toBase58(),
      solBalance: solBal,
      cycleCount: this.cycleCount,
      lastCycleAt: now,
      isRunning: this.isRunning,
      activePositions: [],
    });

    if (this.cycleCount % 10 === 0) {
      const sol2 = await this.connection.getBalance(this.wallet.publicKey) / LAMPORTS_PER_SOL;
      await this.telegram.alertCycleSummary(this.cycleCount, [], sol2);
    }
  }

  // ── Manage existing positions ──────────────────────────────────────────────
  private async managePositions() {
    if (this.activePositions.length === 0) return;
    const toRemove: number[] = [];

    for (let i = 0; i < this.activePositions.length; i++) {
      const pos = this.activePositions[i];
      const status = await checkPositionStatus(this.connection, this.wallet, pos);
      if (!status) { toRemove.push(i); continue; }

      const key = pos.positionKey.publicKey.toBase58();
      this.tracker.updateTrack(key, status.currentValue, status.feeEarned);

      console.log(`  📌 ${pos.poolName}: ${status.isInRange ? '✅' : '❌'} PnL ${status.pnlPercent.toFixed(2)}% fee ${status.feeEarned.toFixed(4)} SOL`);

      if (!status.isInRange) await this.telegram.alertOutOfRange(pos, status.pnlPercent);
      if (status.feeEarned > 0.001) await claimFees(this.connection, this.wallet, pos);

  

      // B. Tracker-based rules (stop loss, trailing stop, max hold)
      const track = this.tracker.getTrack(key);
      const hoursHeld = track?.hoursHeld || 0;
      const closeCheck = this.tracker.shouldClose(key, status.currentValue, status.pnlPercent);
      if (closeCheck.should) {
        console.log(`  🕐 Tracker close: ${closeCheck.reason}`);
        if (await this.close(pos, status, closeCheck.reason, i)) { toRemove.push(i); continue; }
      }

      // C. Rebalance if out of range > 2h
      const rebalCheck = this.tracker.shouldRebalance(key, !status.isInRange);
      if (rebalCheck.should) {
        console.log(`  🔄 Rebalance: ${rebalCheck.reason}`);
        await closePosition(this.connection, this.wallet, pos);
        toRemove.push(i); this.tracker.removePosition(key); continue;
      }

      // D. AI evaluation when critical (PnL < -3% or out of range > 1h)
      const isCritical = status.pnlPercent < -3 || (!status.isInRange && hoursHeld > 1);
      const isScheduled = hoursHeld > 0 && Math.round(hoursHeld * 60) % 90 === 0;
      if (isCritical || isScheduled) {
        const pool = this.pools.find(p => p.address === pos.poolAddress);
        const mom = pool ? (await getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol)) : null;
        const prompt = this.buildClosePrompt(status, mom, pool, hoursHeld);
        const decision = await askAI(prompt);
        if (decision.action === 'close_position') {
          console.log(`  🤖 AI close: ${decision.reasoning}`);
          if (await this.close(pos, status, decision.reasoning, i)) toRemove.push(i);
        } else if (decision.action === 'rebalance') {
          await closePosition(this.connection, this.wallet, pos);
          toRemove.push(i); this.tracker.removePosition(key);
        } else {
          console.log(`  🤖 AI hold: ${decision.reasoning}`);
        }
      }
    }

    for (const idx of toRemove.reverse()) this.activePositions.splice(idx, 1);
  }

  private async close(pos: ActivePosition, status: PositionStatus, reason: string, idx: number): Promise<boolean> {
    const ok = await closePosition(this.connection, this.wallet, pos);
    if (ok) {
      this.tracker.removePosition(pos.positionKey.publicKey.toBase58());
      await this.telegram.alertPositionClosed(pos, status.pnlPercent, status.feeEarned, reason);
    }
    return ok;
  }

  // ── Find & enter new positions ────────────────────────────────────────────
  private async findAndEnter(solBal: number) {
    const topPools = rankPools(this.pools);
    if (topPools.length === 0) { console.log('⚠️  Tidak ada pool qualified'); return; }

    // Skip pool yang sudah ada posisinya
    const openAddrs = new Set(this.activePositions.map(p => p.poolAddress));

    // Pool terbaik dari metric (vol/TVL, APR, momentum) — LP Army filter
    for (const pool of topPools.filter(p => !openAddrs.has(p.address)).slice(0, 2)) {
      if (this.activePositions.length >= CONFIG.agent.maxPositions) break;
      await this.evaluatePool(pool, solBal, null);
    }
  }

  private async evaluatePool(pool: PoolInfo, solBal: number, consensusData: any) {
    // Hard filters
    const [bundlerReport, rugCheck, momentum] = await Promise.all([
      checkBundlerActivity(this.connection, pool.address),
      checkRug(pool.tokenX.mint),
      getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol),
    ]);

    if (bundlerReport.suspicionScore > 70) { console.log(`  🚨 Skip MEV: ${pool.name}`); return; }
    if (rugCheck.rugScore > 80 || rugCheck.hasFreezable) { console.log(`  🚨 Skip rug: ${pool.name}`); return; }

    // Market cap filter — skip token dengan mcap < $500K
    // Data dari DexScreener via momentum fetch
    if (momentum.marketCap > 0 && momentum.marketCap < 500_000) {
      console.log(`  🚨 Skip low mcap: ${pool.name} ($${(momentum.marketCap/1000).toFixed(0)}K < $500K)`);
      return;
    }

    // Likuiditas minimum — skip pool hampir kosong
    if (pool.tvl < 10_000) {
      console.log(`  🚨 Skip low TVL: ${pool.name} ($${pool.tvl.toLocaleString()} < $10K)`);
      return;
    }

    // Allocation
    const mult = consensusData ? Math.min(2, 1 + consensusData.traderCount * 0.3) : getSolAllocationMultiplier(pool);
    const solAmount = Math.min(CONFIG.agent.solPerPosition * mult, solBal * 0.4);

    const volatilityData = await analyzeVolatility(pool.tokenX.mint, pool.tokenX.symbol, pool.binStep);
    const topPools = rankPools(this.pools).slice(0, 3);

    const prompt = this.buildEntryPrompt(topPools, bundlerReport, volatilityData, solBal, solAmount, momentum, rugCheck, consensusData);
    const decision = await askAI(prompt);

    if (decision.action !== 'open_position' || !decision.poolAddress) {
      console.log(`  🤚 AI skip: ${decision.reasoning}`);
      return;
    }
    if (decision.confidence < 50) { console.log(`  ⚠️  Low confidence (${decision.confidence}%)`); return; }

    const targetPool = this.pools.find(p => p.address === decision.poolAddress) || pool;
    const newPos = await openPosition(
      this.connection, this.wallet,
      decision.poolAddress, targetPool.name,
      decision, solAmount
    );

    if (newPos) {
      this.activePositions.push(newPos);
      this.tracker.addPosition(newPos, momentum.currentPrice);
      await this.telegram.alertPositionOpened(newPos, decision);
      console.log(`  ✅ Posisi dibuka: ${targetPool.name} | ${solAmount.toFixed(3)} SOL`);
    }
  }

  // ── Prompt builders ────────────────────────────────────────────────────────
  private buildEntryPrompt(pools: any[], bundler: any, vol: any, solBal: number, solAmt: number, momentum: any, rug: any, consensus: any): string {
      const binRange = consensus?.avgBinRange || CONFIG.agent.defaultBinRange;
    const strategy = consensus?.dominantStrategy || 'BidAskImBalanced';

    return `Kamu adalah DLMM LP agent. Putuskan: open_position atau skip?

=== WALLET ===
SOL: ${solBal.toFixed(4)} | Posisi aktif: ${this.activePositions.length}/${CONFIG.agent.maxPositions}
SOL untuk posisi ini: ${solAmt.toFixed(3)}

=== STRATEGI MEME LP ===
- FOKUS: Vol/TVL ratio >= 5x, APR >= 50%, pool age 2-48 jam
- Strategy: SELALU SOL-only one-sided (tidak pernah dual side)

3 STRATEGY MODES (dari LP Army bear market guide):
1. SPOT_PUMP: token sedang pump → range ±34, max hold 2 JAM, exit sebelum MM lelah
2. SPOT_DUMP: token dump >50% lalu retrace 10-20% → range ±30, max hold 3 jam, entry di bottom
3. BIDASK_FLIP: pool >3 hari, harga stabil/sideways → range ±20, set di support, flip saat sideways

TOKEN SELECTION (filter ketat dari artikel):
- Min market cap: $200K
- Min holders: 500
- Volume 50-100K/5 menit untuk fast play, 10-20K untuk strong runner
- Cek narasi: viral? memeable? bukan politik? bukan revamp token?
- Default bin range: ±${binRange}

BEAR MARKET RULES:
- Jangan hold >2 jam untuk degen play (MM bisa capek kapan saja)
- BidAsk Flip hanya untuk pool >3 hari yang terbukti survive
- Single-side SOL selalu — tidak perlu beli token
- JANGAN skip hanya karena FMS rendah — vol/TVL lebih penting
- Entry kalau 3 dari 5 terpenuhi: vol/TVL>=5x, APR>=50%, age 2-48h, FMS>20, top trader signal

=== DATA POOL ===
${formatPoolsForAI(pools)}

=== PRICE MOMENTUM ===
${formatMomentumForAI(momentum, rug)}

=== BUNDLER/MEV ===
${formatBundlerReportForAI(bundler)}

=== VOLATILITAS ===
${formatVolatilityForAI(vol)}



${consensus ? `=== CONSENSUS SIGNAL ===
Pool ini dimasuki ${consensus.traderCount} top traders!
Strategy mereka: ${consensus.dominantStrategy} | Bin range: ±${consensus.avgBinRange}
Avg PnL: ${consensus.avgPnlPercent?.toFixed(2)}% — OVERRIDE pertimbangan lain jika signal kuat
` : ''}

Respond HANYA JSON:
{"action":"open_position"|"skip","poolAddress":"address|null","strategyType":"${strategy}","binRange":${binRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
  }

  private buildClosePrompt(status: PositionStatus, momentum: any, pool: any, hoursHeld: number): string {
    return `Evaluasi posisi DLMM — hold, close_position, atau rebalance?

Pool: ${status.position.poolName} | Hold: ${hoursHeld.toFixed(1)}h
In range: ${status.isInRange} | PnL: ${status.pnlPercent.toFixed(2)}% | Fee: ${status.feeEarned.toFixed(4)} SOL
Vol/TVL: ${pool?.volumeTvlRatio?.toFixed(1) || '?'}x | Price 1h: ${momentum?.priceChange1h?.toFixed(1) || '?'}%

CLOSE jika: PnL<-${CONFIG.agent.maxLossPercent}%, out of range>2h + vol mati (vol/TVL<3x), hold>6h, price dump>15%/1h
REBALANCE jika: out of range tapi vol/TVL masih >5x
HOLD jika: in range, fee mengalir, momentum positif

JSON: {"action":"hold"|"close_position"|"rebalance","reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
  }
}
