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
import { recordPoolResult, isBlacklisted, getPoolMemorySignal, formatPoolMemoryForAI } from '../modules/poolMemory';

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
  private recentlyClosedPools: Map<string, number> = new Map();
  private outOfRangeRightSince: Map<string, number> = new Map();
  private tokenSidePositions: Set<string> = new Set();
  private totalFeeCompounded = 0;
  private dailyStats = { date: '', wins: 0, losses: 0, totalPnl: 0, totalFee: 0, startSol: 0 };

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

    // Register Telegram command handler
    this.telegram.setCommandHandler(async (cmd: string) => {
      if (cmd === 'close_all') {
        console.log('\n📱 Telegram: close semua posisi');
        for (let i = this.activePositions.length - 1; i >= 0; i--) {
          const pos = this.activePositions[i];
          const status = await checkPositionStatus(this.connection, this.wallet, pos);
          if (status) await this.close(pos, status, 'Manual close via Telegram', i);
        }
        this.activePositions = [];
        savePositions([]);
        await this.telegram.send('✅ Semua posisi berhasil ditutup');
      } else if (cmd === 'get_positions') {
        if (this.activePositions.length === 0) {
          await this.telegram.send('📭 Tidak ada posisi aktif');
        } else {
          const lines = this.activePositions.map(p => {
            const track = this.tracker.getTrack(p.positionKey.publicKey.toBase58());
            return `📌 <b>${p.poolName}</b>\nSOL: ${p.solDeposited.toFixed(3)} | Hold: ${(track?.hoursHeld || 0).toFixed(1)}h | ${p.strategyType}`;
          }).join('\n\n');
          await this.telegram.send(`📊 <b>Posisi Aktif (${this.activePositions.length})</b>\n\n${lines}`);
        }
      } else if (cmd === 'get_memory') {
        const { getAllPoolMemory } = await import('../modules/poolMemory');
        const memories = getAllPoolMemory().slice(0, 10);
        if (memories.length === 0) {
          await this.telegram.send('📭 Belum ada pool memory');
        } else {
          const lines = memories.map(m =>
            `${m.blacklisted ? '🚫' : m.winRate >= 50 ? '✅' : '⚠️'} <b>${m.poolName}</b>\n${m.deploys} deploy | Win ${m.winRate}% | Avg ${m.avgPnl.toFixed(2)}%`
          ).join('\n\n');
          await this.telegram.send(`🧠 <b>Pool Memory</b>\n\n${lines}`);
        }
      }
    });
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
    if (this.telegram.getBotPaused()) {
      console.log('⏸ Bot di-pause via Telegram — skip cycle');
      return;
    }
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
      // Push pool data ke dashboard real-time
      updateDashboardState({
        topPools: this.pools.slice(0, 10),
        lastScanAt: new Date().toLocaleTimeString('id-ID'),
      } as any);
    }

    // Monitor posisi aktif
    await this.managePositions();

    // Cari posisi baru hanya kalau slot kosong
    const slots = CONFIG.agent.maxPositions - this.activePositions.length;
    const hasFunds = solBal >= CONFIG.agent.solPerPosition + 0.02;
    const hourUTC = new Date().getUTCHours();
    const isQuietHours = hourUTC >= 17 && hourUTC < 23;
    if (isQuietHours && this.activePositions.length === 0) {
      const wibHour = (hourUTC + 7) % 24;
      console.log(`  🌙 Jam sepi (${wibHour.toString().padStart(2,'0')}:xx WIB) — skip scan pool baru`);
    }
    if (slots > 0 && hasFunds && !isQuietHours) {
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

    // Daily summary jam 23:50 WIB (16:50 UTC)
    const utcHour = new Date().getUTCHours();
    const utcMin = new Date().getUTCMinutes();
    const todayStr = new Date().toISOString().split('T')[0];
    if (!this.dailyStats.date) { this.dailyStats.date = todayStr; this.dailyStats.startSol = solBal; }
    if (utcHour === 16 && utcMin >= 50 && this.dailyStats.date !== todayStr) {
      this.dailyStats.date = todayStr;
      const sol2 = await this.connection.getBalance(this.wallet.publicKey) / LAMPORTS_PER_SOL;
      const pnlSol = sol2 - this.dailyStats.startSol;
      await this.telegram.send(
        `📅 <b>Daily Summary</b>\n\n` +
        `💰 SOL: ${this.dailyStats.startSol.toFixed(4)} → ${sol2.toFixed(4)} (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)})` +
        `\n✅ Wins: ${this.dailyStats.wins} | ❌ Losses: ${this.dailyStats.losses}` +
        `\n💸 Fee: ${this.dailyStats.totalFee.toFixed(4)} SOL` +
        `\n🔄 Cycles: ${this.cycleCount}`
      );
      this.dailyStats = { date: todayStr, wins: 0, losses: 0, totalPnl: 0, totalFee: 0, startSol: sol2 };
    }
  }

  // ── Manage positions ───────────────────────────────────────────────────────
  private async managePositions() {
    if (this.activePositions.length === 0) return false;
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

      // ── BidAsk Flip: SOL terkonversi semua ke token ──────────────────
      if (status.solConvertedToToken && !status.isInRange) {
        console.log(`\n🔄 BidAsk FLIP: ${pos.poolName} — SOL habis jadi token, reopen token-side`);
        if (status.feeEarned > 0) await claimFees(this.connection, this.wallet, pos);
        const closed = await closePosition(this.connection, this.wallet, pos);
        if (closed) {
          // Tidak set cooldown — perlu langsung reopen token-side
          toRemove.push(i);
          this.tracker.removePosition(key);
          savePositions(this.activePositions.filter((_, j) => j !== i));
          this.flipTargetPool = pos.poolAddress;
          this.flipTargetName = pos.poolName;
          await this.telegram.alertPositionClosed(pos, status.pnlPercent, status.feeEarned, 'BidAsk Flip — reopen token-side');
        }
        continue;
      }

      // ── Take profit / Token-side selesai: token terkonversi semua ke SOL ───────
      if (status.tokenConvertedToSol && !status.isInRange) {
        const isTokenSide = this.tokenSidePositions.has(key);
        if (isTokenSide) {
          console.log(`\n🔄 Token-side selesai: ${pos.poolName} — tanya AI next step`);
          const pool = this.pools.find(p => p.address === pos.poolAddress);
          const mom = pool ? await getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol) : null;
          const prompt = this.buildTokenSideCompletePrompt(status, mom, pool);
          const decision = await askAI(prompt);
          console.log(`  🤖 AI: ${decision.action}(${decision.confidence}%) — ${decision.reasoning}`);
          if (status.feeEarned > 0) await claimFees(this.connection, this.wallet, pos);
          const closed = await closePosition(this.connection, this.wallet, pos);
          if (closed) {
            this.tokenSidePositions.delete(key);
            this.recentlyClosedPools.set(pos.poolAddress, Date.now());
            recordPoolResult(pos.poolAddress, pos.poolName, status.pnlPercent, status.feeEarned, 'token-side complete');
            toRemove.push(i);
            this.tracker.removePosition(key);
            savePositions(this.activePositions.filter((_, j) => j !== i));
            await this.telegram.alertPositionClosed(pos, status.pnlPercent, status.feeEarned, 'Token-side complete: ' + decision.reasoning);
            if (decision.action === 'open_position' && decision.poolAddress === pos.poolAddress) {
              this.flipTargetPool = pos.poolAddress;
              this.flipTargetName = pos.poolName + ' (SOL side retry)';
              console.log(`  ✅ AI: balik SOL side di ${pos.poolName}`);
            }
          }
        } else {
          console.log(`\n✅ Take profit: ${pos.poolName} — semua token jadi SOL`);
          if (status.feeEarned > 0) await claimFees(this.connection, this.wallet, pos);
          const closed = await closePosition(this.connection, this.wallet, pos);
          if (closed) {
            this.recentlyClosedPools.set(pos.poolAddress, Date.now());
            recordPoolResult(pos.poolAddress, pos.poolName, status.pnlPercent, status.feeEarned, 'take profit');
            toRemove.push(i);
            this.tracker.removePosition(key);
            savePositions(this.activePositions.filter((_, j) => j !== i));
            await this.telegram.alertPositionClosed(pos, status.pnlPercent, status.feeEarned, 'Token converted to SOL — take profit');
          }
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

      // ── Out of range KANAN tracker ─────────────────────────────
      const posKey = pos.positionKey.publicKey.toBase58();
      if (!status.isInRange && !status.solConvertedToToken && !status.tokenConvertedToSol) {
        if (!this.outOfRangeRightSince.has(posKey)) {
          this.outOfRangeRightSince.set(posKey, Date.now());
          console.log(`  ⚡ ${pos.poolName}: harga pump di atas range — mulai timer 5 menit`);
        }
      } else {
        this.outOfRangeRightSince.delete(posKey);
      }
      const outOfRangeRightMs = this.outOfRangeRightSince.has(posKey)
        ? Date.now() - this.outOfRangeRightSince.get(posKey)!
        : 0;
      const outOfRangeRightMinutes = outOfRangeRightMs / 60000;
      if (outOfRangeRightMinutes > 5) {
        console.log(`  ⚡ ${pos.poolName}: out of range kanan ${outOfRangeRightMinutes.toFixed(1)} menit — AI evaluasi`);
      }

      // ── Stop loss berbasis fee ─────────────────────────────────────────────
      const feeVsLoss = status.feeEarned - Math.abs(Math.min(0, status.pnlPercent / 100 * pos.solDeposited));
      const feeProtected = feeVsLoss > 0;
      const noFeeAfter30Min = (track?.hoursHeld || 0) > 0.5 && status.feeEarned < 0.0001;
      if (noFeeAfter30Min && !status.isInRange) {
        console.log(`  💸 ${pos.poolName}: 30 menit tidak ada fee + out of range — cut loss`);
        if (await this.close(pos, status, 'No fee after 30min + out of range', i)) toRemove.push(i);
        continue;
      }
      const effectiveLossThreshold = feeProtected ? -40 : -30;

      // ── AI evaluation saat kritis ────────────────────────────────────────
      const hoursHeld = track?.hoursHeld || 0;
      const isCritical =
        status.pnlPercent < effectiveLossThreshold ||  // -30% normal, -40% kalau fee cover loss
        (!status.isInRange && hoursHeld > 1) ||
        outOfRangeRightMinutes > 5;
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
      this.recentlyClosedPools.set(pos.poolAddress, Date.now());
      recordPoolResult(pos.poolAddress, pos.poolName, status.pnlPercent, status.feeEarned, reason);
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
        console.log(`\n🔄 Reopen token-side: ${this.flipTargetName}`);
        await this.reopenTokenSide(flipPool, solBal);
      }
      this.flipTargetPool = null;
      this.flipTargetName = null;
      return false;
    }

    if (topPools.length === 0) { console.log('⚠️  Tidak ada pool qualified'); return; }

    // Kumpulkan semua kandidat pool dulu (max 5), skip yang ada di blacklist/rug
    // Lalu AI evaluate semua sekaligus dan pilih yang terbaik
    const COOLDOWN_MS = 10 * 60 * 1000;
    for (const [addr, ts] of this.recentlyClosedPools.entries()) {
      if (Date.now() - ts > COOLDOWN_MS) this.recentlyClosedPools.delete(addr);
    }
    const candidates = topPools
      .filter(p => !openAddrs.has(p.address))
      .filter(p => {
        const closedAt = this.recentlyClosedPools.get(p.address);
        if (closedAt) {
          const minAgo = ((Date.now() - closedAt) / 60000).toFixed(1);
          console.log(`   ⏳ Skip ${p.name} — cooldown ${minAgo}/10 menit`);
          return false;
        }
        return true;
      })
      .slice(0, 5);

    if (candidates.length === 0) { console.log('⚠️  Semua pool sudah ada posisi'); return; }

    console.log(`\n🔍 Evaluating ${candidates.length} pool candidates...`);
    candidates.forEach((p, i) =>
      console.log(`   ${i+1}. ${p.name} | organic:${p.organicScore} | fee/tvl:${p.feeActiveTvlRatio.toFixed(4)} | ${p.strategy} | score:${p.compositeScore}`)
    );

    // Evaluate satu per satu sampai berhasil buka posisi
    for (const pool of candidates) {
      if (this.activePositions.length >= CONFIG.agent.maxPositions) break;
      const opened = await this.evaluatePool(pool, solBal, null);
      if (opened) break; // Berhasil buka — stop
    }
  }

  private async evaluatePool(pool: PoolInfo, solBal: number, extra: any): Promise<boolean> {
    const [bundlerReport, rugCheck, momentum] = await Promise.all([
      checkBundlerActivity(this.connection, pool.address),
      checkRug(pool.tokenX.mint),
      getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol),
    ]);

    if (bundlerReport.suspicionScore > 70) { console.log(`  🚨 Skip MEV: ${pool.name}`); return false; }
    if (rugCheck.rugScore > 80 || rugCheck.hasFreezable) { console.log(`  🚨 Skip rug: ${pool.name}`); return false; }
    if (momentum.marketCap > 0 && momentum.marketCap < 200_000) {
      console.log(`  🚨 Skip low mcap: ${pool.name} ($${(momentum.marketCap/1000).toFixed(0)}K)`); return false;
    }
    if (pool.tvl < 50) { console.log(`  🚨 Skip low TVL: ${pool.name}`); return false; }
    if (pool.poolAgeDays !== undefined && pool.poolAgeDays < 1) {
      console.log(`  🚨 Skip pool terlalu baru: ${pool.name} (${pool.poolAgeDays.toFixed(1)} hari)`); return false;
    }

    const mult = getSolAllocationMultiplier(pool);
    const kellySol = this.getKellySize(pool.address);
    const solAmount = Math.min(kellySol * mult, solBal * 0.4);
    const volatilityData = await analyzeVolatility(pool.tokenX.mint, pool.tokenX.symbol, pool.binStep);
    const topPools = rankPools(this.pools).slice(0, 3);

    const prompt = this.buildEntryPrompt(topPools, bundlerReport, volatilityData, solBal, solAmount, momentum, rugCheck);
    const decision = await askAI(prompt);

    if (decision.action !== 'open_position' || !decision.poolAddress) {
      console.log(`  🤚 AI skip: ${decision.reasoning}`); return false;
    }
    if (decision.confidence < 30) { console.log(`  ⚠️  Very low confidence (${decision.confidence}%), skip`); return false; }

    let targetPool = this.pools.find(p => p.address === decision.poolAddress) || pool;

    // Kalau confidence < 80% — tanya user via Telegram dulu
    if (decision.confidence < 80) {
      console.log(`  🤔 Confidence ${decision.confidence}% < 80% — tanya user via Telegram...`);
      const topPools = rankPools(this.pools).slice(0, 5);
      const selectedIdx = await this.telegram.askPoolSelection(topPools, decision, solBal);

      if (selectedIdx === -1) {
        console.log(`  ❌ User skip semua pool`);
        return false;
      }
      targetPool = topPools[selectedIdx] || targetPool;
      console.log(`  ✅ User pilih: ${targetPool.name}`);
    } else {
      console.log(`  ✅ AI confident (${decision.confidence}%) — auto entry`);
      // Tetap kirim notif scan ke Telegram meskipun auto
      await this.telegram.alertPoolScan(rankPools(this.pools).slice(0, 3), this.cycleCount);
    }

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
      return true;
    }
    return false;
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

=== STRATEGI SELECTION (WAJIB IKUTI) ===

5 STRATEGY (pilih berdasarkan kondisi pool):

1. stable_range (TERBAIK, fee concentrated):
   Syarat: |price1h| < 5%, organic >= 80, vol/TVL >= 2x, pool >= 3 hari
   → SPOT symmetric, binRange 17-20, bins_above = bins_below, max hold 6 jam

2. volume_surge (fee income tinggi):
   Syarat: fee/TVL > 0.15, vol/TVL >= 5x, organic >= 65
   → BID_ASK SOL-only, binRange 34, bins_above = 0, max hold 1 jam

3. bidask_flip (proven bear market):
   Syarat: organic >= 75, |price1h| < 15%, pool >= 2 hari
   → BID_ASK SOL-only, binRange 20-34, bins_above = 0, max hold 6 jam

4. spot_dump/dump_recovery (risky):
   Syarat: price turun >20% DAN trend sudah mulai naik lagi (konfirmasi reversal)
   → BID_ASK SOL-only, binRange 30-50, max hold 3 jam

5. spot_pump (DEPRECATED, hindari):
   Hanya kalau: price naik >10% DAN fee/TVL > 0.12 DAN organic >= 65
   → BID_ASK SOL-only, binRange 34-50, max hold 1 jam SAJA

HARD RULES:
  - bid_ask → bins_above HARUS 0, deposit SOL only
  - spot → bins_above = bins_below (symmetric)
  - JANGAN pakai curve
  - bin step hanya 80-125
  - TVL > $50, mcap > $200K
  - Pool < 1 hari → SKIP

=== DATA POOL ===
${formatPoolsForAI(pools)}

=== PRICE MOMENTUM ===
${formatMomentumForAI(momentum, rug)}

=== BUNDLER/MEV ===
${formatBundlerReportForAI(bundler)}

=== VOLATILITAS ===
${formatVolatilityForAI(vol)}

JSON: {"action":"open_position"|"skip","poolAddress":"address|null","strategyType":"bid_ask"|"spot","binRange":${CONFIG.agent.defaultBinRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
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
  getKellySize(poolAddress: string): number {
    const base = CONFIG.agent.solPerPosition;
    try {
      const { getPoolMemory } = require('../modules/poolMemory');
      const mem = getPoolMemory(poolAddress);
      if (!mem || mem.deploys < 3) return base;
      const winRate = mem.winRate / 100;
      const lossRate = 1 - winRate;
      const kelly = (winRate * 0.05 - lossRate * 0.03) / 0.05;
      const multiplier = Math.max(0.5, Math.min(1.5, 1 + kelly / 2));
      const adjusted = base * multiplier;
      console.log(`   💰 Kelly: ${adjusted.toFixed(3)} SOL (${multiplier.toFixed(2)}x | wr ${mem.winRate}%)`);
      return adjusted;
    } catch { return base; }
  }

  determineStrategy(pool: any, momentum: any, volatilityData: any): { strategy: 'bid_ask' | 'spot'; reason: string; binRange: number } {
    const price1h = momentum?.priceChange1h || 0;
    const volatility = volatilityData?.volatility || 0;
    const organicScore = pool?.organicScore || 0;
    const volTvl = pool?.volumeTvlRatio || 0;
    const poolAgeDays = pool?.poolAgeDays ?? 999;

    let binRange = volatility >= 6 ? 69 : volatility >= 4 ? 50 : volatility >= 2 ? 34 : volatility >= 1 ? 25 : 17;

    const isSideways = Math.abs(price1h) <= 2;
    const isStable = volatility < 2.5;
    const isOrganic = organicScore >= 80;
    const hasGoodFee = volTvl >= 3;

    if (isSideways && isStable && isOrganic && hasGoodFee) {
      const spotBinRange = Math.min(binRange, 20);
      return { strategy: 'spot', reason: `Sideways ${price1h.toFixed(1)}%/1h, vol ${volatility.toFixed(1)}, organic ${organicScore} -> binRange ${spotBinRange}`, binRange: spotBinRange };
    }

    const reasons: string[] = [];
    if (Math.abs(price1h) > 2) reasons.push(`price ${price1h.toFixed(1)}%/1h`);
    if (volatility >= 2.5) reasons.push(`vol ${volatility.toFixed(1)}`);
    if (organicScore < 80) reasons.push(`organic ${organicScore}`);
    if (volTvl < 3) reasons.push(`vol/TVL ${volTvl.toFixed(1)}x`);
    if (poolAgeDays < 3) { reasons.push(`pool baru ${poolAgeDays.toFixed(1)}d`); binRange = Math.min(binRange * 1.5, 69); }

    return { strategy: 'bid_ask', reason: (reasons.join(', ') || 'default') + ` -> binRange ${Math.round(binRange)} | age ${poolAgeDays.toFixed(1)}d`, binRange: Math.round(binRange) };
  }

  async reopenTokenSide(pool: any, solBal: number): Promise<void> {
    const solAmount = Math.min(CONFIG.agent.solPerPosition, solBal * 0.4);
    console.log(`  📥 Token-side reopen: ${pool.name} | ${solAmount.toFixed(3)} SOL`);
    const forcedDecision: any = {
      action: 'open_position',
      poolAddress: pool.address,
      strategyType: 'bid_ask',
      binRange: CONFIG.agent.defaultBinRange,
      binsAbove: CONFIG.agent.defaultBinRange,
      binsBelow: 0,
      reasoning: 'Token-side reopen setelah BidAsk FLIP',
      riskLevel: 'medium',
      confidence: 90,
    };
    const newPos = await openPosition(this.connection, this.wallet, pool.address, pool.name, forcedDecision, solAmount);
    if (newPos) {
      const momentum = await getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol);
      this.activePositions.push(newPos);
      this.tracker.addPosition(newPos, momentum.currentPrice);
      this.tokenSidePositions.add(newPos.positionKey.publicKey.toBase58());
      savePositions(this.activePositions);
      await this.telegram.alertPositionOpened(newPos, forcedDecision);
      console.log(`  ✅ Token-side dibuka: ${pool.name} | ${solAmount.toFixed(3)} SOL`);
    } else {
      console.log(`  ❌ Gagal buka token-side: ${pool.name}`);
      this.recentlyClosedPools.set(pool.address, Date.now());
    }
  }

  buildTokenSideCompletePrompt(status: any, momentum: any, pool: any): string {
    return `Token-side posisi DLMM selesai (semua token jadi SOL). Putuskan next step.

Pool: ${status.position?.poolName || 'Unknown'}
PnL: ${status.pnlPercent?.toFixed(2) || '?'}% | Fee: ${status.feeEarned?.toFixed(4) || '?'} SOL
Vol/TVL: ${pool?.volumeTvlRatio?.toFixed(1) || '?'}x
Price 1h: ${momentum?.priceChange1h?.toFixed(1) || '?'}%
Mcap: $${((momentum?.marketCap || 0)/1000).toFixed(0)}K

OPSI:
- open_position: Balik SOL-side di pool yang sama (kalau vol/TVL >3x, price tidak dump >20%)
- skip: Cari pool lain

JSON: {"action":"open_position"|"skip","poolAddress":"${status.position?.poolAddress || ''}|null","strategyType":"bid_ask","binRange":${CONFIG.agent.defaultBinRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
  }


}
