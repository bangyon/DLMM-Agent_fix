import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import * as fs from 'fs';
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
import { recordPerformance, getLessonsForPrompt, getPerformanceSummary } from '../modules/lessons';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Position Persistence ───────────────────────────────────────────────────
const POSITIONS_FILE = 'data/active-positions.json';

function savePositions(positions: ActivePosition[]) {
  try {
    fs.mkdirSync('data', { recursive: true });
    const data = positions.map(p => ({
      poolAddress: p.poolAddress,
      poolName: p.poolName,
      positionKey: p.positionKey.publicKey.toBase58(),
      strategyType: String(p.strategyType),
      binRange: p.binRange,
      solDeposited: p.solDeposited,
      openedAt: p.openedAt,
      entryPrice: p.entryPrice,
    }));
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) { console.error('Save positions error:', err); }
}

function loadPositions(): any[] {
  try {
    if (!fs.existsSync(POSITIONS_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    console.log(`   📂 Loaded ${data.length} saved position(s) from disk`);
    return data;
  } catch { return []; }
}

function makeRecovered(saved: any): ActivePosition {
  return {
    poolAddress: saved.poolAddress,
    poolName: saved.poolName,
    positionKey: { publicKey: { toBase58: () => saved.positionKey } } as any,
    strategyType: saved.strategyType as any,
    binRange: saved.binRange || 34,
    solDeposited: saved.solDeposited || 0,
    openedAt: new Date(saved.openedAt),
    entryPrice: saved.entryPrice || 0,
    lastChecked: new Date(),
  };
}

export class DLMMAgent {
  private connection: Connection;
  private wallet: Keypair;
  private activePositions: ActivePosition[] = [];
  private isRunning = false;
  private cycleCount = 0;
  private telegram: TelegramAlert;
  private tracker: PositionTracker;
  private pools: PoolInfo[] = [];
  private lastPoolFetchAt = 0;
  private flipTargetPool: string | null = null;
  private flipTargetName: string | null = null;
  private stream: any = null;

  constructor() {
    // pump.helius.com lebih cepat untuk meme tokens
    const rpcUrl = CONFIG.rpc.url.includes('helius') 
      ? CONFIG.rpc.url.replace('mainnet.helius', 'pump.helius')
      : CONFIG.rpc.url;
    this.connection = new Connection(rpcUrl, 'confirmed');
    console.log(`   RPC: ${rpcUrl.split('?')[0]}`);
    this.wallet = Keypair.fromSecretKey(bs58.decode(CONFIG.wallet.privateKey));
    this.telegram = new TelegramAlert();
    this.tracker = new PositionTracker();
    console.log(`\n🤖 DLMM Agent — wallet: ${this.wallet.publicKey.toBase58()}`);
    console.log(`   AI: ${CONFIG.ai.provider} | SOL/pos: ${CONFIG.agent.solPerPosition} | max: ${CONFIG.agent.maxPositions}`);
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

    // 1. Recover dari file
    const savedPositions = loadPositions();
    if (savedPositions.length > 0) {
      console.log(`\n⚡ Recovering ${savedPositions.length} position(s) dari file...`);
      for (const saved of savedPositions) {
        try {
          const recovered = makeRecovered(saved);
          this.activePositions.push(recovered);
          this.tracker.addPosition(recovered, 0);
          console.log(`   ✅ Recovered: ${saved.poolName} | dibuka ${new Date(saved.openedAt).toLocaleString('id-ID')}`);
        } catch (err) {
          console.log(`   ⚠️  Gagal recover ${saved.poolName}: ${err}`);
        }
      }
    }

    // 2. Fallback: cek blockchain via LP Agent kalau file kosong
    if (this.activePositions.length === 0 && CONFIG.ai.lpAgentApiKey) {
      console.log('\n🔍 File kosong — cek blockchain via LP Agent...');
      try {
        const res = await fetch(
          `https://api.lpagent.io/open-api/v1/lp-positions/opening?owner=${this.wallet.publicKey.toBase58()}`,
          { headers: { 'x-api-key': CONFIG.ai.lpAgentApiKey } }
        );
        const data = await res.json() as any;
        if (data.status === 'success' && data.count > 0) {
          console.log(`   Found ${data.count} posisi aktif di blockchain!`);
          for (const p of data.data) {
            const r = p.range || [];
            const binRange = r.length >= 2 ? Math.round(Math.abs(r[1]-r[0])/2) : 34;
            const recovered = makeRecovered({
              poolAddress: p.pool || '',
              poolName: p.pairName || 'Unknown',
              positionKey: p.positionAddress || p.pool,
              strategyType: p.strategyType || 'BidAsk',
              binRange,
              solDeposited: parseFloat(p.inputValue || '0'),
              openedAt: new Date(Date.now() - parseFloat(p.age || '0') * 3600000),
              entryPrice: 0,
            });
            this.activePositions.push(recovered);
            this.tracker.addPosition(recovered, 0);
            savePositions(this.activePositions);
            console.log(`   ✅ Synced: ${recovered.poolName} | age ${p.age}h | PnL ${p.pnl?.percent?.toFixed(2)}%`);
          }
        } else {
          console.log('   Tidak ada posisi aktif di blockchain');
        }
      } catch (err) {
        console.log(`   ⚠️  LP Agent fallback failed: ${err}`);
      }
    }

    if (this.activePositions.length >= CONFIG.agent.maxPositions) {
      console.log(`\n⚠️  ${this.activePositions.length} posisi aktif — hanya monitor, tidak buka posisi baru`);
    }

    while (this.isRunning) {
      try { await this.cycle(); }
      catch (err) {
        console.error('❌ Cycle error:', err);
        await this.telegram.alertError('Cycle error', String(err));
      }
      await sleep(CONFIG.agent.checkIntervalSeconds * 1000);
    }
  }

  stop() { this.isRunning = false; console.log('🛑 Stopped'); }

  private async cycle() {
    this.cycleCount++;
    const now = new Date().toLocaleString('id-ID');
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`🔄 Cycle #${this.cycleCount} — ${now}`);

    const solBal = await this.connection.getBalance(this.wallet.publicKey) / LAMPORTS_PER_SOL;
    console.log(`💰 ${solBal.toFixed(4)} SOL | Posisi: ${this.activePositions.length}/${CONFIG.agent.maxPositions}`);

    // Refresh pool list setiap 30 detik
    if (Date.now() - this.lastPoolFetchAt > 30_000) {
      this.pools = await getTopPools(30);
      this.lastPoolFetchAt = Date.now();
    }

    // Monitor posisi aktif
    await this.managePositions();

    // Cari posisi baru hanya kalau slot kosong
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
      activePositions: this.activePositions.map(p => {
        const track = this.tracker.getTrack(p.positionKey.publicKey.toBase58());
        return {
          poolAddress: p.poolAddress,
          poolName: p.poolName,
          solDeposited: p.solDeposited,
          openedAt: p.openedAt,
          strategyType: String(p.strategyType),
          pnlPercent: 0,
          feeEarned: track?.feeAccumulated || 0,
          hoursHeld: track?.hoursHeld || 0,
          isInRange: true,
        };
      }),
    });

    if (this.cycleCount % 10 === 0) {
      const sol2 = await this.connection.getBalance(this.wallet.publicKey) / LAMPORTS_PER_SOL;
      await this.telegram.alertCycleSummary(this.cycleCount, [], sol2);
    }
  }

  // ── Manage positions ───────────────────────────────────────────────────────
  private async managePositions() {
    if (this.activePositions.length === 0) return;
    const toRemove: number[] = [];

    for (let i = 0; i < this.activePositions.length; i++) {
      const pos = this.activePositions[i];
      const status = await checkPositionStatus(this.connection, this.wallet, pos);
      if (!status) { toRemove.push(i); continue; }

      const key = pos.positionKey.publicKey.toBase58();
      this.tracker.updateTrack(key, status.currentValue, status.feeEarned);
      const track = this.tracker.getTrack(key);

      console.log(`  📌 ${pos.poolName}: ${status.isInRange ? '✅' : '❌'} PnL ${status.pnlPercent.toFixed(2)}% fee ${status.feeEarned.toFixed(4)} SOL | ${track?.hoursHeld.toFixed(1)}h`);

      // Sync dashboard real-time
      updateDashboardState({
        wallet: this.wallet.publicKey.toBase58(),
        solBalance: 0,
        cycleCount: this.cycleCount,
        lastCycleAt: new Date().toLocaleString('id-ID'),
        isRunning: this.isRunning,
        activePositions: [{
          poolAddress: pos.poolAddress,
          poolName: pos.poolName,
          solDeposited: pos.solDeposited,
          openedAt: pos.openedAt,
          strategyType: String(pos.strategyType),
          pnlPercent: status.pnlPercent,
          feeEarned: status.feeEarned,
          hoursHeld: track?.hoursHeld || 0,
          isInRange: status.isInRange,
        }],
      });

      if (!status.isInRange) await this.telegram.alertOutOfRange(pos, status.pnlPercent);
      if (status.feeEarned > 0.001) await claimFees(this.connection, this.wallet, pos);

      // ── BidAsk Flip: SOL terkonversi semua ke token ──────────────────────
      if (status.solConvertedToToken && !status.isInRange) {
        console.log(`\n🔄 BidAsk FLIP: ${pos.poolName} — SOL habis jadi token, reopen token-side`);
        if (status.feeEarned > 0) await claimFees(this.connection, this.wallet, pos);
        const closed = await closePosition(this.connection, this.wallet, pos);
        if (closed) {
          toRemove.push(i);
          this.tracker.removePosition(key);
          savePositions(this.activePositions.filter((_, j) => j !== i));
          this.flipTargetPool = pos.poolAddress;
          this.flipTargetName = pos.poolName;
          await this.telegram.alertPositionClosed(pos, status.pnlPercent, status.feeEarned, 'BidAsk Flip — reopen token-side');
        }
        continue;
      }

      // ── Take profit: token terkonversi semua ke SOL ──────────────────────
      if (status.tokenConvertedToSol && !status.isInRange) {
        console.log(`\n✅ Take profit: ${pos.poolName} — semua token jadi SOL`);
        if (status.feeEarned > 0) await claimFees(this.connection, this.wallet, pos);
        const closed = await closePosition(this.connection, this.wallet, pos);
        if (closed) {
          toRemove.push(i);
          this.tracker.removePosition(key);
          savePositions(this.activePositions.filter((_, j) => j !== i));
          await this.telegram.alertPositionClosed(pos, status.pnlPercent, status.feeEarned, 'Token converted to SOL — take profit');
        }
        continue;
      }

      // ── Tracker rules ────────────────────────────────────────────────────
      const closeCheck = this.tracker.shouldClose(key, status.currentValue, status.pnlPercent);
      if (closeCheck.should) {
        console.log(`\n🕐 Close: ${closeCheck.reason}`);
        if (await this.close(pos, status, closeCheck.reason, i)) toRemove.push(i);
        continue;
      }

      const rebalCheck = this.tracker.shouldRebalance(key, !status.isInRange);
      if (rebalCheck.should) {
        console.log(`\n🔄 Rebalance: ${rebalCheck.reason}`);
        await closePosition(this.connection, this.wallet, pos);
        toRemove.push(i);
        this.tracker.removePosition(key);
        savePositions(this.activePositions.filter((_, j) => j !== i));
        continue;
      }

      // ── AI evaluation saat kritis ────────────────────────────────────────
      const hoursHeld = track?.hoursHeld || 0;
      const isCritical = status.pnlPercent < -3 || (!status.isInRange && hoursHeld > 1);
      if (isCritical) {
        const pool = this.pools.find(p => p.address === pos.poolAddress);
        const mom = pool ? await getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol) : null;
        const prompt = this.buildClosePrompt(status, mom, pool, hoursHeld);
        const decision = await askAI(prompt);
        if (decision.action === 'close_position') {
          console.log(`\n🤖 AI close: ${decision.reasoning}`);
          if (await this.close(pos, status, decision.reasoning, i)) toRemove.push(i);
        } else if (decision.action === 'rebalance') {
          await closePosition(this.connection, this.wallet, pos);
          toRemove.push(i); this.tracker.removePosition(key);
          savePositions(this.activePositions.filter((_, j) => j !== i));
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
      const key = pos.positionKey.publicKey.toBase58();
      const track = this.tracker.getTrack(key);
      // Record performance untuk learning system
      await recordPerformance({
        pool: pos.poolAddress,
        poolName: pos.poolName,
        strategy: String(pos.strategyType),
        binRange: pos.binRange,
        binStep: 100, // default
        organicScore: 0,
        holders: 0,
        marketCap: 0,
        feeActiveTvlRatio: 0,
        solDeposited: pos.solDeposited,
        feesEarnedSol: status.feeEarned,
        finalValueSol: status.currentValue,
        initialValueSol: pos.solDeposited,
        minutesInRange: 0,
        minutesHeld: (track?.hoursHeld || 0) * 60,
        closeReason: reason,
      });
      this.tracker.removePosition(key);
      await this.telegram.alertPositionClosed(pos, status.pnlPercent, status.feeEarned, reason);
      savePositions(this.activePositions.filter((_, i) => i !== idx));
    }
    return ok;
  }

  // ── Find & enter ───────────────────────────────────────────────────────────
  private async findAndEnter(solBal: number) {
    const topPools = rankPools(this.pools);

    // Cek posisi aktif di blockchain via LP Agent (termasuk posisi manual)
    // Ini mencegah double posisi kalau user buka manual dari UI Meteora
    let onChainPools = new Set<string>();
    if (CONFIG.ai.lpAgentApiKey) {
      try {
        const res = await fetch(
          `https://api.lpagent.io/open-api/v1/lp-positions/opening?owner=${this.wallet.publicKey.toBase58()}`,
          { headers: { 'x-api-key': CONFIG.ai.lpAgentApiKey } }
        );
        const data = await res.json() as any;
        if (data.status === 'success' && data.count > 0) {
          for (const p of data.data) {
            if (p.pool) onChainPools.add(p.pool);
          }
          // Sync posisi manual yang belum ada di memory
          for (const p of data.data) {
            const alreadyTracked = this.activePositions.some(pos => pos.poolAddress === p.pool);
            if (!alreadyTracked && p.pool) {
              const r = p.range || [];
              const binRange = r.length >= 2 ? Math.round(Math.abs(r[1]-r[0])/2) : 34;
              const manual = makeRecovered({
                poolAddress: p.pool,
                poolName: p.pairName || 'Manual Position',
                positionKey: p.positionAddress || p.pool,
                strategyType: p.strategyType || 'BidAsk',
                binRange,
                solDeposited: parseFloat(p.inputValue || '0'),
                openedAt: new Date(Date.now() - parseFloat(p.age || '0') * 3600000),
                entryPrice: 0,
              });
              this.activePositions.push(manual);
              this.tracker.addPosition(manual, 0);
              savePositions(this.activePositions);
              console.log(`  📥 Manual position detected: ${manual.poolName} | age ${p.age}h`);
              await this.telegram.alertError('Manual position detected', `${manual.poolName} — synced ke bot`);
            }
          }
          if (onChainPools.size > 0) {
            console.log(`  🔍 On-chain positions: ${onChainPools.size} (termasuk manual)`);
          }
        }
      } catch {}
    }

    // Gabungkan pool dari memory + blockchain
    const openAddrs = new Set([
      ...this.activePositions.map(p => p.poolAddress),
      ...onChainPools,
    ]);

    // Prioritas flip target
    if (this.flipTargetPool) {
      const flipPool = this.pools.find(p => p.address === this.flipTargetPool);
      if (flipPool && !openAddrs.has(flipPool.address)) {
        console.log(`\n🔄 Reopen flip: ${this.flipTargetName}`);
        await this.evaluatePool(flipPool, solBal, { isFlip: true });
      }
      this.flipTargetPool = null;
      this.flipTargetName = null;
      return;
    }

    if (topPools.length === 0) { console.log('⚠️  Tidak ada pool qualified'); return; }

    for (const pool of topPools.filter(p => !openAddrs.has(p.address)).slice(0, 2)) {
      if (this.activePositions.length >= CONFIG.agent.maxPositions) break;
      await this.evaluatePool(pool, solBal, null);
    }
  }

  private async evaluatePool(pool: PoolInfo, solBal: number, extra: any) {
    const [bundlerReport, rugCheck, momentum] = await Promise.all([
      checkBundlerActivity(this.connection, pool.address),
      checkRug(pool.tokenX.mint),
      getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol),
    ]);

    if (bundlerReport.suspicionScore > 70) { console.log(`  🚨 Skip MEV: ${pool.name}`); return; }
    if (rugCheck.rugScore > 80 || rugCheck.hasFreezable) { console.log(`  🚨 Skip rug: ${pool.name}`); return; }
    if (momentum.marketCap > 0 && momentum.marketCap < 200_000) {
      console.log(`  🚨 Skip low mcap: ${pool.name} ($${(momentum.marketCap/1000).toFixed(0)}K)`); return;
    }
    if (pool.tvl < 50) { console.log(`  🚨 Skip low TVL: ${pool.name}`); return; }

    const mult = getSolAllocationMultiplier(pool);
    const solAmount = Math.min(CONFIG.agent.solPerPosition * mult, solBal * 0.4);
    const volatilityData = await analyzeVolatility(pool.tokenX.mint, pool.tokenX.symbol, pool.binStep);
    const topPools = rankPools(this.pools).slice(0, 3);

    const prompt = this.buildEntryPrompt(topPools, bundlerReport, volatilityData, solBal, solAmount, momentum, rugCheck);
    const decision = await askAI(prompt);

    if (decision.action !== 'open_position' || !decision.poolAddress) {
      console.log(`  🤚 AI skip: ${decision.reasoning}`); return;
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
      savePositions(this.activePositions);
      await this.telegram.alertPositionOpened(newPos, decision);
      console.log(`  ✅ Posisi dibuka: ${targetPool.name} | ${solAmount.toFixed(3)} SOL`);
    }
  }

  // ── Prompts ────────────────────────────────────────────────────────────────
  private buildEntryPrompt(pools: any[], bundler: any, vol: any, solBal: number, solAmt: number, momentum: any, rug: any): string {
    return `Kamu adalah DLMM LP agent. Putuskan: open_position atau skip?

=== WALLET ===
SOL: ${solBal.toFixed(4)} | Posisi: ${this.activePositions.length}/${CONFIG.agent.maxPositions}
SOL untuk posisi ini: ${solAmt.toFixed(3)}

=== LESSONS DARI POSISI SEBELUMNYA ===
\${getLessonsForPrompt(8) || 'Belum ada lessons'}

Performance: \${getPerformanceSummary()}

=== STRATEGI BEAR MARKET (LP Army) ===
- SOL-only one-sided, tidak pernah dual side
- 3 modes: SPOT_PUMP (max 2j), SPOT_DUMP (max 3j), BIDASK_FLIP (max 6j)
- Token filter: mcap >$200K, holders >500, vol/TVL >2x
- BidAsk Flip: pool >3 hari, stabil, set di support
- Jangan masuk pool TVL <$50 atau mcap <$200K

=== DATA POOL ===
${formatPoolsForAI(pools)}

=== PRICE MOMENTUM ===
${formatMomentumForAI(momentum, rug)}

=== BUNDLER/MEV ===
${formatBundlerReportForAI(bundler)}

=== VOLATILITAS ===
${formatVolatilityForAI(vol)}

JSON: {"action":"open_position"|"skip","poolAddress":"address|null","strategyType":"BidAsk","binRange":${CONFIG.agent.defaultBinRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
  }

  private buildClosePrompt(status: PositionStatus, momentum: any, pool: any, hoursHeld: number): string {
    return `Evaluasi posisi DLMM — hold, close_position, atau rebalance?

Pool: ${status.position.poolName} | Hold: ${hoursHeld.toFixed(1)}h
In range: ${status.isInRange} | PnL: ${status.pnlPercent.toFixed(2)}% | Fee: ${status.feeEarned.toFixed(4)} SOL
Vol/TVL: ${pool?.volumeTvlRatio?.toFixed(1) || '?'}x | Price 1h: ${momentum?.priceChange1h?.toFixed(1) || '?'}%
SOL in pos: ${status.totalSolInPosition?.toFixed(4)} | Token in pos: ${status.totalTokenInPosition?.toFixed(0)}

CLOSE: PnL<-${CONFIG.agent.maxLossPercent}%, out of range >2h + vol mati, hold >2h, dump >15%/1h
REBALANCE: out of range tapi vol/TVL >5x
HOLD: in range, fee mengalir, momentum positif

JSON: {"action":"hold"|"close_position"|"rebalance","reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
  }
}
