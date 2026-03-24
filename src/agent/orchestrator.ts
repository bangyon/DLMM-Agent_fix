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
  private tokenSidePositions: Set<string> = new Set(); // posKey yang sedang token-side

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
        for (let i = 0; i < this.activePositions.length; i++) {
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
            return `📌 <b>${p.poolName}</b>\nSOL: ${p.solDeposited.toFixed(3)} | Hold: ${track?.hoursHeld.toFixed(1) || 0}h | Strategy: ${p.strategyType}`;
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
            `${m.blacklisted ? '🚫' : m.winRate >= 50 ? '✅' : '⚠️'} <b>${m.poolName}</b>\n${m.deploys} deploy | Win ${m.winRate}% | Avg PnL ${m.avgPnl.toFixed(2)}%`
          ).join('\n\n');
          await this.telegram.send(`🧠 <b>Pool Memory</b>\n\n${lines}`);
        }
      } else if (cmd === 'pause') {
        await this.telegram.send('⏸ Bot di-pause. Posisi aktif tetap dimonitor.');
      } else if (cmd === 'resume') {
        await this.telegram.send('▶️ Bot resume! Akan scan pool di cycle berikutnya.');
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
    // Cek pause dari Telegram
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

    // Time-based filter: hindari jam sepi (00:00 - 06:00 WIB = 17:00-23:00 UTC)
    const hourUTC = new Date().getUTCHours();
    const isQuietHours = hourUTC >= 17 && hourUTC < 23; // 00:00-06:00 WIB
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

      // ── BidAsk Flip: SOL terkonversi semua ke token ──────────────────────
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
          // Token-side selesai — AI evaluate: balik SOL side atau cari pool lain?
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
          // SOL side biasa — take profit
          console.log(`\n✅ Take profit: ${pos.poolName} — semua token jadi SOL`);
          if (status.feeEarned > 0) await claimFees(this.connection, this.wallet, pos);
          const closed = await closePosition(this.connection, this.wallet, pos);
          if (closed) {
            this.recentlyClosedPools.set(pos.poolAddress, Date.now());
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

      // ── Out of range KANAN tracker ───────────────────────────────────────────
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

      // ── AI evaluation saat kritis ──────────────────────────────────────────────
      const hoursHeld = track?.hoursHeld || 0;
      // ── Stop loss berbasis fee ─────────────────────────────────────────────
      // Kalau fee sudah cover loss → hold lebih lama (fee protecting position)
      // Kalau 30 menit tidak ada fee sama sekali → cut loss lebih cepat
      const feeVsLoss = status.feeEarned - Math.abs(Math.min(0, status.pnlPercent / 100 * pos.solDeposited));
      const feeProtected = feeVsLoss > 0; // fee sudah cover impermanent loss
      const noFeeAfter30Min = hoursHeld > 0.5 && status.feeEarned < 0.0001;

      if (noFeeAfter30Min && !status.isInRange) {
        console.log(`  💸 ${pos.poolName}: 30 menit tidak ada fee + out of range — cut loss`);
        if (await this.close(pos, status, 'No fee after 30min + out of range', i)) toRemove.push(i);
        continue;
      }

      // Fee protecting: kalau fee sudah cover loss, naikkan threshold close ke -10%
      const effectiveLossThreshold = feeProtected ? -10 : -5;

      const isCritical =
        status.pnlPercent < effectiveLossThreshold ||                    // Loss threshold -3% → -5%
        (!status.isInRange && hoursHeld > 1) ||       // Out of range > 1 jam
        outOfRangeRightMinutes > 5;                   // Out of range KANAN > 5 menit
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
      // Record ke pool memory untuk tracking win rate
      recordPoolResult(pos.poolAddress, pos.poolName, status.pnlPercent, status.feeEarned, reason);
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
      .filter(p => {
        if (isBlacklisted(p.address)) {
          console.log(`   🚫 Skip ${p.name} — blacklisted di pool memory`);
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

    const mult = getSolAllocationMultiplier(pool);
    const kellySol = this.getKellySize(pool.address);
    const solAmount = Math.min(kellySol * mult, solBal * 0.4);
    const volatilityData = await analyzeVolatility(pool.tokenX.mint, pool.tokenX.symbol, pool.binStep);
    const topPools = rankPools(this.pools).slice(0, 3);

    const strategyRec = this.determineStrategy(pool, momentum, volatilityData);
    console.log(`   📊 Strategy rec: ${strategyRec.strategy.toUpperCase()} — ${strategyRec.reason}`);
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

Pilih bid_ask KALAU salah satu terpenuhi:
  - priceChange1h > +3% (token lagi pump)
  - priceChange1h < -5% (token dump, tunggu reversal)
  - volatility > 3.0 (harga bergerak liar)
  - Pool umur < 3 hari (token masih fresh/volatile)
  - Tidak ada sinyal sideways yang jelas

Pilih spot KALAU SEMUA terpenuhi:
  - priceChange1h antara -2% sampai +2% (sideways)
  - organic score >= 80 (real user, bukan bot)
  - volatility < 2.5 (harga relatif stabil)
  - Vol/TVL > 3x (fee mengalir tapi harga tidak liar)
  - Pool sudah > 3 hari (established pool)

HARD RULES:
  - bid_ask → binRange 34-69, bins_above HARUS 0, deposit SOL only
  - spot → binRange 17-34, bins_above = bins_below (symmetric)
  - JANGAN pakai curve
  - bin step hanya 80-125
  - TVL > $50, mcap > $200K

=== DATA POOL ===
${formatPoolsForAI(pools)}

=== PRICE MOMENTUM ===
${formatMomentumForAI(momentum, rug)}

=== BUNDLER/MEV ===
${formatBundlerReportForAI(bundler)}

=== VOLATILITAS ===
${formatVolatilityForAI(vol)}

=== REKOMENDASI STRATEGI (berdasarkan data) ===
${this.determineStrategy(pools[0], momentum, vol).strategy.toUpperCase()}: ${this.determineStrategy(pools[0], momentum, vol).reason}

=== POOL MEMORY (history bot ini) ===
${formatPoolMemoryForAI(pools[0]?.address || "")}

JSON: {"action":"open_position"|"skip","poolAddress":"address|null","strategyType":"bid_ask"|"spot","binRange":${CONFIG.agent.defaultBinRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
  }



  // ── Kelly criterion: adjust SOL size berdasarkan win rate ───────────────────
  private getKellySize(poolAddress: string): number {
    const base = CONFIG.agent.solPerPosition;
    const { getPoolMemory } = require('../modules/poolMemory');
    const mem = getPoolMemory(poolAddress);

    if (!mem || mem.deploys < 3) return base; // belum cukup data → pakai base

    const winRate = mem.winRate / 100;
    const avgWin = 0.05;   // asumsi avg win +5%
    const avgLoss = 0.03;  // asumsi avg loss -3%

    // Kelly fraction = (winRate * avgWin - lossRate * avgLoss) / avgWin
    const lossRate = 1 - winRate;
    const kelly = (winRate * avgWin - lossRate * avgLoss) / avgWin;

    // Gunakan half-Kelly untuk safety, clamp antara 0.5x-1.5x base
    const halfKelly = kelly / 2;
    const multiplier = Math.max(0.5, Math.min(1.5, 1 + halfKelly));

    const adjusted = base * multiplier;
    console.log(`   💰 Kelly size: ${adjusted.toFixed(3)} SOL (${multiplier.toFixed(2)}x base | win rate ${mem.winRate}% dari ${mem.deploys} deploy)`);
    return adjusted;
  }

  // ── Pre-determine strategy berdasarkan data real ──────────────────────────
  private determineStrategy(pool: any, momentum: any, volatilityData: any): {
    strategy: 'bid_ask' | 'spot';
    reason: string;
    binRange: number;
  } {
    const price1h = momentum?.priceChange1h || 0;
    const price24h = momentum?.priceChange24h || 0;
    const volatility = volatilityData?.volatility || 0;
    const organicScore = pool?.organicScore || 0;
    const volTvl = pool?.volumeTvlRatio || 0;

    // ── Dynamic bin range berdasarkan volatility ──────────────────────────
    // Semakin volatile → range lebih lebar supaya tidak cepat out of range
    let binRange: number;
    if (volatility >= 6)      binRange = 69;  // sangat volatile
    else if (volatility >= 4) binRange = 50;  // volatile
    else if (volatility >= 2) binRange = 34;  // normal
    else if (volatility >= 1) binRange = 25;  // stabil
    else                      binRange = 17;  // sangat stabil

    // ── Kondisi SPOT: SEMUA harus terpenuhi ──────────────────────────────
    const isSideways = Math.abs(price1h) <= 2;
    const isStable = volatility < 2.5;
    const isOrganic = organicScore >= 80;
    const hasGoodFee = volTvl >= 3;

    if (isSideways && isStable && isOrganic && hasGoodFee) {
      // Spot pakai bin range lebih sempit — concentrated liquidity
      const spotBinRange = Math.min(binRange, 20);
      return {
        strategy: 'spot',
        reason: `Sideways (${price1h.toFixed(1)}%/1h), vol ${volatility.toFixed(1)}, organic ${organicScore}, vol/TVL ${volTvl.toFixed(1)}x → binRange ${spotBinRange}`,
        binRange: spotBinRange,
      };
    }

    // ── BID_ASK: semua kondisi lain ───────────────────────────────────────
    const reasons = [];
    if (Math.abs(price1h) > 2) reasons.push(`price ${price1h.toFixed(1)}%/1h`);
    if (volatility >= 2.5) reasons.push(`vol ${volatility.toFixed(1)}`);
    if (organicScore < 80) reasons.push(`organic ${organicScore}`);
    if (volTvl < 3) reasons.push(`vol/TVL ${volTvl.toFixed(1)}x`);

    return {
      strategy: 'bid_ask',
      reason: (reasons.join(', ') || 'default') + ` → binRange ${binRange}`,
      binRange,
    };
  }

  // ── Reopen token-side setelah BidAsk FLIP ─────────────────────────────────
  private async reopenTokenSide(pool: PoolInfo, solBal: number): Promise<void> {
    const solAmount = Math.min(CONFIG.agent.solPerPosition, solBal * 0.4);
    console.log(`  📥 Token-side reopen: ${pool.name} | ${solAmount.toFixed(3)} SOL`);

    // Force decision token-side: bins_above > 0, bins_below = 0
    const forcedDecision = {
      action: 'open_position' as const,
      poolAddress: pool.address,
      strategyType: 'bid_ask' as const,
      binRange: CONFIG.agent.defaultBinRange,
      binsAbove: CONFIG.agent.defaultBinRange,
      binsBelow: 0,
      reasoning: 'Token-side reopen setelah BidAsk FLIP',
      riskLevel: 'medium' as const,
      confidence: 90,
    };

    const newPos = await openPosition(
      this.connection, this.wallet,
      pool.address, pool.name,
      forcedDecision, solAmount
    );

    if (newPos) {
      const momentum = await getTokenMomentum(pool.tokenX.mint, pool.tokenX.symbol);
      this.activePositions.push(newPos);
      this.tracker.addPosition(newPos, momentum.currentPrice);
      // Tandai sebagai token-side
      this.tokenSidePositions.add(newPos.positionKey.publicKey.toBase58());
      savePositions(this.activePositions);
      await this.telegram.alertPositionOpened(newPos, forcedDecision);
      console.log(`  ✅ Token-side dibuka: ${pool.name} | ${solAmount.toFixed(3)} SOL`);
    } else {
      console.log(`  ❌ Gagal buka token-side: ${pool.name}`);
      // Set cooldown baru supaya tidak langsung retry
      this.recentlyClosedPools.set(pool.address, Date.now());
    }
  }

  private buildTokenSideCompletePrompt(status: PositionStatus, momentum: any, pool: any): string {
    return `Token-side posisi DLMM selesai (semua token → SOL). Putuskan next step.

Pool: ${status.position.poolName}
PnL total: ${status.pnlPercent.toFixed(2)}% | Fee: ${status.feeEarned.toFixed(4)} SOL
Vol/TVL: ${pool?.volumeTvlRatio?.toFixed(1) || '?'}x
Price 1h: ${momentum?.priceChange1h?.toFixed(1) || '?'}% | 24h: ${momentum?.priceChange24h?.toFixed(1) || '?'}%
Mcap: $${((momentum?.marketCap || 0)/1000).toFixed(0)}K | Holders: ${momentum?.holders || '?'}

OPSI:
- open_position (poolAddress = alamat pool ini): Balik SOL-side di pool yang sama, harga sudah retraced cukup
- skip: Cari pool lain, pool ini sudah tidak menarik

PERTIMBANGAN:
- Balik SOL side kalau: vol/TVL masih >3x, price tidak dump >20% dari entry, pool masih aktif
- Skip kalau: momentum negatif kuat, vol/TVL rendah, pool sudah sepi

JSON: {"action":"open_position"|"skip","poolAddress":"${status.position.poolAddress}|null","strategyType":"bid_ask","binRange":${CONFIG.agent.defaultBinRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
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
