"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DLMMAgent = void 0;
const web3_js_1 = require("@solana/web3.js");
const bs58_1 = __importDefault(require("bs58"));
const fs = __importStar(require("fs"));
const config_1 = require("../config");
const brain_1 = require("./brain");
const poolFinder_1 = require("../modules/poolFinder");
const bundlerChecker_1 = require("../modules/bundlerChecker");
const positionManager_1 = require("../modules/positionManager");
const jupiter_1 = require("../modules/jupiter");
const telegram_1 = require("../alerts/telegram");
const feeTracker_1 = require("../utils/feeTracker");
const server_1 = require("../dashboard/server");
const simulator_1 = require("../backtest/simulator");
const priceFeed_1 = require("../modules/priceFeed");
const positionTracker_1 = require("../modules/positionTracker");
const lessons_1 = require("../modules/lessons");
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// ── Position Persistence ───────────────────────────────────────────────────
const POSITIONS_FILE = 'data/active-positions.json';
function savePositions(positions) {
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
    }
    catch (err) {
        console.error('Save positions error:', err);
    }
}
function loadPositions() {
    try {
        if (!fs.existsSync(POSITIONS_FILE))
            return [];
        const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
        console.log(`   📂 Loaded ${data.length} saved position(s) from disk`);
        return data;
    }
    catch {
        return [];
    }
}
function makeRecovered(saved) {
    return {
        poolAddress: saved.poolAddress,
        poolName: saved.poolName,
        positionKey: { publicKey: { toBase58: () => saved.positionKey } },
        strategyType: saved.strategyType,
        binRange: saved.binRange || 34,
        solDeposited: saved.solDeposited || 0,
        openedAt: new Date(saved.openedAt),
        entryPrice: saved.entryPrice || 0,
        lastChecked: new Date(),
    };
}
class DLMMAgent {
    constructor() {
        this.activePositions = [];
        this.isRunning = false;
        this.cycleCount = 0;
        this.pools = [];
        this.lastPoolFetchAt = 0;
        this.flipTargetPool = null;
        this.flipTargetName = null;
        this.stream = null;
        this.recentlyClosedPools = new Map();
        this.outOfRangeRightSince = new Map();
        this.tokenSidePositions = new Set(); // posKey yang sedang token-side
        // pump.helius.com lebih cepat untuk meme tokens
        const rpcUrl = config_1.CONFIG.rpc.url.includes('helius')
            ? config_1.CONFIG.rpc.url.replace('mainnet.helius', 'pump.helius')
            : config_1.CONFIG.rpc.url;
        this.connection = new web3_js_1.Connection(rpcUrl, 'confirmed');
        console.log(`   RPC: ${rpcUrl.split('?')[0]}`);
        this.wallet = web3_js_1.Keypair.fromSecretKey(bs58_1.default.decode(config_1.CONFIG.wallet.privateKey));
        this.telegram = new telegram_1.TelegramAlert();
        this.tracker = new positionTracker_1.PositionTracker();
        console.log(`\n🤖 DLMM Agent — wallet: ${this.wallet.publicKey.toBase58()}`);
        console.log(`   AI: ${config_1.CONFIG.ai.provider} | SOL/pos: ${config_1.CONFIG.agent.solPerPosition} | max: ${config_1.CONFIG.agent.maxPositions}`);
    }
    async runBacktestMode(daysBack = 7) {
        const pools = await (0, poolFinder_1.getTopPools)(10);
        const top = (0, poolFinder_1.rankPools)(pools).slice(0, 3).map(p => ({ address: p.address, name: p.name, binStep: p.binStep }));
        await (0, simulator_1.comparePoolBacktests)(top, daysBack);
    }
    async start() {
        (0, server_1.startDashboard)(parseInt(process.env.DASHBOARD_PORT || '3000'));
        this.isRunning = true;
        console.log('\n🚀 Agent berjalan...\n');
        const sol = await this.connection.getBalance(this.wallet.publicKey) / web3_js_1.LAMPORTS_PER_SOL;
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
                }
                catch (err) {
                    console.log(`   ⚠️  Gagal recover ${saved.poolName}: ${err}`);
                }
            }
        }
        // 2. Fallback: cek blockchain via LP Agent kalau file kosong
        if (this.activePositions.length === 0 && config_1.CONFIG.ai.lpAgentApiKey) {
            console.log('\n🔍 File kosong — cek blockchain via LP Agent...');
            try {
                const res = await fetch(`https://api.lpagent.io/open-api/v1/lp-positions/opening?owner=${this.wallet.publicKey.toBase58()}`, { headers: { 'x-api-key': config_1.CONFIG.ai.lpAgentApiKey } });
                const data = await res.json();
                if (data.status === 'success' && data.count > 0) {
                    console.log(`   Found ${data.count} posisi aktif di blockchain!`);
                    for (const p of data.data) {
                        const r = p.range || [];
                        const binRange = r.length >= 2 ? Math.round(Math.abs(r[1] - r[0]) / 2) : 34;
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
                }
                else {
                    console.log('   Tidak ada posisi aktif di blockchain');
                }
            }
            catch (err) {
                console.log(`   ⚠️  LP Agent fallback failed: ${err}`);
            }
        }
        if (this.activePositions.length >= config_1.CONFIG.agent.maxPositions) {
            console.log(`\n⚠️  ${this.activePositions.length} posisi aktif — hanya monitor, tidak buka posisi baru`);
        }
        while (this.isRunning) {
            try {
                await this.cycle();
            }
            catch (err) {
                console.error('❌ Cycle error:', err);
                await this.telegram.alertError('Cycle error', String(err));
            }
            await sleep(config_1.CONFIG.agent.checkIntervalSeconds * 1000);
        }
    }
    stop() { this.isRunning = false; console.log('🛑 Stopped'); }
    async cycle() {
        this.cycleCount++;
        const now = new Date().toLocaleString('id-ID');
        console.log(`\n${'─'.repeat(55)}`);
        console.log(`🔄 Cycle #${this.cycleCount} — ${now}`);
        const solBal = await this.connection.getBalance(this.wallet.publicKey) / web3_js_1.LAMPORTS_PER_SOL;
        console.log(`💰 ${solBal.toFixed(4)} SOL | Posisi: ${this.activePositions.length}/${config_1.CONFIG.agent.maxPositions}`);
        // Refresh pool list setiap 30 detik
        if (Date.now() - this.lastPoolFetchAt > 30000) {
            this.pools = await (0, poolFinder_1.getTopPools)(30);
            this.lastPoolFetchAt = Date.now();
            // Push pool data ke dashboard real-time
            (0, server_1.updateDashboardState)({
                topPools: this.pools.slice(0, 10),
                lastScanAt: new Date().toLocaleTimeString('id-ID'),
            });
        }
        // Monitor posisi aktif
        await this.managePositions();
        // Cari posisi baru hanya kalau slot kosong
        const slots = config_1.CONFIG.agent.maxPositions - this.activePositions.length;
        const hasFunds = solBal >= config_1.CONFIG.agent.solPerPosition + 0.02;
        if (slots > 0 && hasFunds) {
            await this.findAndEnter(solBal);
        }
        // Update dashboard
        (0, server_1.updateDashboardState)({
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
            const sol2 = await this.connection.getBalance(this.wallet.publicKey) / web3_js_1.LAMPORTS_PER_SOL;
            await this.telegram.alertCycleSummary(this.cycleCount, [], sol2);
        }
    }
    // ── Manage positions ───────────────────────────────────────────────────────
    async managePositions() {
        if (this.activePositions.length === 0)
            return false;
        const toRemove = [];
        for (let i = 0; i < this.activePositions.length; i++) {
            const pos = this.activePositions[i];
            const status = await (0, positionManager_1.checkPositionStatus)(this.connection, this.wallet, pos);
            if (!status) {
                toRemove.push(i);
                continue;
            }
            const key = pos.positionKey.publicKey.toBase58();
            this.tracker.updateTrack(key, status.currentValue, status.feeEarned);
            const track = this.tracker.getTrack(key);
            console.log(`  📌 ${pos.poolName}: ${status.isInRange ? '✅' : '❌'} PnL ${status.pnlPercent.toFixed(2)}% fee ${status.feeEarned.toFixed(4)} SOL | ${track?.hoursHeld.toFixed(1)}h`);
            // Sync dashboard real-time
            (0, server_1.updateDashboardState)({
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
            if (!status.isInRange)
                await this.telegram.alertOutOfRange(pos, status.pnlPercent);
            if (status.feeEarned > 0.001)
                await (0, feeTracker_1.claimFees)(this.connection, this.wallet, pos);
            // ── BidAsk Flip: SOL terkonversi semua ke token ──────────────────────
            if (status.solConvertedToToken && !status.isInRange) {
                console.log(`\n🔄 BidAsk FLIP: ${pos.poolName} — SOL habis jadi token, reopen token-side`);
                if (status.feeEarned > 0)
                    await (0, feeTracker_1.claimFees)(this.connection, this.wallet, pos);
                const closed = await (0, positionManager_1.closePosition)(this.connection, this.wallet, pos);
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
                    const mom = pool ? await (0, priceFeed_1.getTokenMomentum)(pool.tokenX.mint, pool.tokenX.symbol) : null;
                    const prompt = this.buildTokenSideCompletePrompt(status, mom, pool);
                    const decision = await (0, brain_1.askAI)(prompt);
                    console.log(`  🤖 AI: ${decision.action}(${decision.confidence}%) — ${decision.reasoning}`);
                    if (status.feeEarned > 0)
                        await (0, feeTracker_1.claimFees)(this.connection, this.wallet, pos);
                    const closed = await (0, positionManager_1.closePosition)(this.connection, this.wallet, pos);
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
                }
                else {
                    // SOL side biasa — take profit
                    console.log(`\n✅ Take profit: ${pos.poolName} — semua token jadi SOL`);
                    if (status.feeEarned > 0)
                        await (0, feeTracker_1.claimFees)(this.connection, this.wallet, pos);
                    const closed = await (0, positionManager_1.closePosition)(this.connection, this.wallet, pos);
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
                if (await this.close(pos, status, closeCheck.reason, i))
                    toRemove.push(i);
                continue;
            }
            const rebalCheck = this.tracker.shouldRebalance(key, !status.isInRange);
            if (rebalCheck.should) {
                console.log(`\n🔄 Rebalance: ${rebalCheck.reason}`);
                await (0, positionManager_1.closePosition)(this.connection, this.wallet, pos);
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
            }
            else {
                this.outOfRangeRightSince.delete(posKey);
            }
            const outOfRangeRightMs = this.outOfRangeRightSince.has(posKey)
                ? Date.now() - this.outOfRangeRightSince.get(posKey)
                : 0;
            const outOfRangeRightMinutes = outOfRangeRightMs / 60000;
            if (outOfRangeRightMinutes > 5) {
                console.log(`  ⚡ ${pos.poolName}: out of range kanan ${outOfRangeRightMinutes.toFixed(1)} menit — AI evaluasi`);
            }
            // ── AI evaluation saat kritis ──────────────────────────────────────────────
            const hoursHeld = track?.hoursHeld || 0;
            const isCritical = status.pnlPercent < -5 || // Loss threshold -3% → -5%
                (!status.isInRange && hoursHeld > 1) || // Out of range > 1 jam
                outOfRangeRightMinutes > 5; // Out of range KANAN > 5 menit
            if (isCritical) {
                const pool = this.pools.find(p => p.address === pos.poolAddress);
                const mom = pool ? await (0, priceFeed_1.getTokenMomentum)(pool.tokenX.mint, pool.tokenX.symbol) : null;
                const prompt = this.buildClosePrompt(status, mom, pool, hoursHeld);
                const decision = await (0, brain_1.askAI)(prompt);
                if (decision.action === 'close_position') {
                    console.log(`\n🤖 AI close: ${decision.reasoning}`);
                    if (await this.close(pos, status, decision.reasoning, i))
                        toRemove.push(i);
                }
                else if (decision.action === 'rebalance') {
                    await (0, positionManager_1.closePosition)(this.connection, this.wallet, pos);
                    toRemove.push(i);
                    this.tracker.removePosition(key);
                    savePositions(this.activePositions.filter((_, j) => j !== i));
                }
                else {
                    console.log(`  🤖 AI hold: ${decision.reasoning}`);
                }
            }
        }
        for (const idx of toRemove.reverse())
            this.activePositions.splice(idx, 1);
    }
    async close(pos, status, reason, idx) {
        const ok = await (0, positionManager_1.closePosition)(this.connection, this.wallet, pos);
        if (ok) {
            this.recentlyClosedPools.set(pos.poolAddress, Date.now());
            const key = pos.positionKey.publicKey.toBase58();
            const track = this.tracker.getTrack(key);
            // Record performance untuk learning system
            await (0, lessons_1.recordPerformance)({
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
    async findAndEnter(solBal) {
        const topPools = (0, poolFinder_1.rankPools)(this.pools);
        // Cek posisi aktif di blockchain via LP Agent (termasuk posisi manual)
        // Ini mencegah double posisi kalau user buka manual dari UI Meteora
        let onChainPools = new Set();
        if (config_1.CONFIG.ai.lpAgentApiKey) {
            try {
                const res = await fetch(`https://api.lpagent.io/open-api/v1/lp-positions/opening?owner=${this.wallet.publicKey.toBase58()}`, { headers: { 'x-api-key': config_1.CONFIG.ai.lpAgentApiKey } });
                const data = await res.json();
                if (data.status === 'success' && data.count > 0) {
                    for (const p of data.data) {
                        if (p.pool)
                            onChainPools.add(p.pool);
                    }
                    // Sync posisi manual yang belum ada di memory
                    for (const p of data.data) {
                        const alreadyTracked = this.activePositions.some(pos => pos.poolAddress === p.pool);
                        if (!alreadyTracked && p.pool) {
                            const r = p.range || [];
                            const binRange = r.length >= 2 ? Math.round(Math.abs(r[1] - r[0]) / 2) : 34;
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
            }
            catch { }
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
        if (topPools.length === 0) {
            console.log('⚠️  Tidak ada pool qualified');
            return;
        }
        // Kumpulkan semua kandidat pool dulu (max 5), skip yang ada di blacklist/rug
        // Lalu AI evaluate semua sekaligus dan pilih yang terbaik
        const COOLDOWN_MS = 10 * 60 * 1000;
        for (const [addr, ts] of this.recentlyClosedPools.entries()) {
            if (Date.now() - ts > COOLDOWN_MS)
                this.recentlyClosedPools.delete(addr);
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
        if (candidates.length === 0) {
            console.log('⚠️  Semua pool sudah ada posisi');
            return;
        }
        console.log(`\n🔍 Evaluating ${candidates.length} pool candidates...`);
        candidates.forEach((p, i) => console.log(`   ${i + 1}. ${p.name} | organic:${p.organicScore} | fee/tvl:${p.feeActiveTvlRatio.toFixed(4)} | ${p.strategy} | score:${p.compositeScore}`));
        // Evaluate satu per satu sampai berhasil buka posisi
        for (const pool of candidates) {
            if (this.activePositions.length >= config_1.CONFIG.agent.maxPositions)
                break;
            const opened = await this.evaluatePool(pool, solBal, null);
            if (opened)
                break; // Berhasil buka — stop
        }
    }
    async evaluatePool(pool, solBal, extra) {
        const [bundlerReport, rugCheck, momentum] = await Promise.all([
            (0, bundlerChecker_1.checkBundlerActivity)(this.connection, pool.address),
            (0, priceFeed_1.checkRug)(pool.tokenX.mint),
            (0, priceFeed_1.getTokenMomentum)(pool.tokenX.mint, pool.tokenX.symbol),
        ]);
        if (bundlerReport.suspicionScore > 70) {
            console.log(`  🚨 Skip MEV: ${pool.name}`);
            return false;
        }
        if (rugCheck.rugScore > 80 || rugCheck.hasFreezable) {
            console.log(`  🚨 Skip rug: ${pool.name}`);
            return false;
        }
        if (momentum.marketCap > 0 && momentum.marketCap < 200000) {
            console.log(`  🚨 Skip low mcap: ${pool.name} ($${(momentum.marketCap / 1000).toFixed(0)}K)`);
            return false;
        }
        if (pool.tvl < 50) {
            console.log(`  🚨 Skip low TVL: ${pool.name}`);
            return false;
        }
        const mult = (0, poolFinder_1.getSolAllocationMultiplier)(pool);
        const solAmount = Math.min(config_1.CONFIG.agent.solPerPosition * mult, solBal * 0.4);
        const volatilityData = await (0, jupiter_1.analyzeVolatility)(pool.tokenX.mint, pool.tokenX.symbol, pool.binStep);
        const topPools = (0, poolFinder_1.rankPools)(this.pools).slice(0, 3);
        const prompt = this.buildEntryPrompt(topPools, bundlerReport, volatilityData, solBal, solAmount, momentum, rugCheck);
        const decision = await (0, brain_1.askAI)(prompt);
        if (decision.action !== 'open_position' || !decision.poolAddress) {
            console.log(`  🤚 AI skip: ${decision.reasoning}`);
            return false;
        }
        if (decision.confidence < 30) {
            console.log(`  ⚠️  Very low confidence (${decision.confidence}%), skip`);
            return false;
        }
        let targetPool = this.pools.find(p => p.address === decision.poolAddress) || pool;
        // Kalau confidence < 80% — tanya user via Telegram dulu
        if (decision.confidence < 80) {
            console.log(`  🤔 Confidence ${decision.confidence}% < 80% — tanya user via Telegram...`);
            const topPools = (0, poolFinder_1.rankPools)(this.pools).slice(0, 5);
            const selectedIdx = await this.telegram.askPoolSelection(topPools, decision, solBal);
            if (selectedIdx === -1) {
                console.log(`  ❌ User skip semua pool`);
                return false;
            }
            targetPool = topPools[selectedIdx] || targetPool;
            console.log(`  ✅ User pilih: ${targetPool.name}`);
        }
        else {
            console.log(`  ✅ AI confident (${decision.confidence}%) — auto entry`);
            // Tetap kirim notif scan ke Telegram meskipun auto
            await this.telegram.alertPoolScan((0, poolFinder_1.rankPools)(this.pools).slice(0, 3), this.cycleCount);
        }
        const newPos = await (0, positionManager_1.openPosition)(this.connection, this.wallet, decision.poolAddress, targetPool.name, decision, solAmount);
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
    buildEntryPrompt(pools, bundler, vol, solBal, solAmt, momentum, rug) {
        return `Kamu adalah DLMM LP agent. Putuskan: open_position atau skip?

=== WALLET ===
SOL: ${solBal.toFixed(4)} | Posisi: ${this.activePositions.length}/${config_1.CONFIG.agent.maxPositions}
SOL untuk posisi ini: ${solAmt.toFixed(3)}

=== LESSONS DARI POSISI SEBELUMNYA ===
\${getLessonsForPrompt(8) || 'Belum ada lessons'}

Performance: \${getPerformanceSummary()}

=== STRATEGI BEAR MARKET (LP Army) ===
STRATEGY SELECTION (pilih berdasarkan kondisi):

bid_ask (default untuk meme):
  - SOL-only, deposit HANYA di bawah active bin (bins_above = 0)
  - Terbaik saat: token volatile, harga mungkin turun, ingin capture fee dari pump
  - Max hold: 2 jam (spot_pump) atau 6 jam (bidask_flip untuk pool >3 hari)
  - Bins: 34-69 standard, 100+ untuk wide range

spot (saat kondisi lebih stabil):
  - Bisa dual-sided atau SOL-only dengan range symmetric
  - Terbaik saat: token sideways, harga stable, organic score tinggi (>80)
  - Bins above = bins below (symmetric)
  - Max hold: 3-4 jam

HARD RULES:
  - bid_ask → bins_above HARUS 0
  - spot → bins_above = bins_below
  - JANGAN pernah gunakan 'curve'
  - Bin step hanya 80-125
  - Jangan masuk pool TVL <$50 atau mcap <$200K

=== DATA POOL ===
${(0, poolFinder_1.formatPoolsForAI)(pools)}

=== PRICE MOMENTUM ===
${(0, priceFeed_1.formatMomentumForAI)(momentum, rug)}

=== BUNDLER/MEV ===
${(0, bundlerChecker_1.formatBundlerReportForAI)(bundler)}

=== VOLATILITAS ===
${(0, jupiter_1.formatVolatilityForAI)(vol)}

JSON: {"action":"open_position"|"skip","poolAddress":"address|null","strategyType":"bid_ask"|"spot","binRange":${config_1.CONFIG.agent.defaultBinRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
    }
    // ── Reopen token-side setelah BidAsk FLIP ─────────────────────────────────
    async reopenTokenSide(pool, solBal) {
        const solAmount = Math.min(config_1.CONFIG.agent.solPerPosition, solBal * 0.4);
        console.log(`  📥 Token-side reopen: ${pool.name} | ${solAmount.toFixed(3)} SOL`);
        // Force decision token-side: bins_above > 0, bins_below = 0
        const forcedDecision = {
            action: 'open_position',
            poolAddress: pool.address,
            strategyType: 'bid_ask',
            binRange: config_1.CONFIG.agent.defaultBinRange,
            binsAbove: config_1.CONFIG.agent.defaultBinRange,
            binsBelow: 0,
            reasoning: 'Token-side reopen setelah BidAsk FLIP',
            riskLevel: 'medium',
            confidence: 90,
        };
        const newPos = await (0, positionManager_1.openPosition)(this.connection, this.wallet, pool.address, pool.name, forcedDecision, solAmount);
        if (newPos) {
            const momentum = await (0, priceFeed_1.getTokenMomentum)(pool.tokenX.mint, pool.tokenX.symbol);
            this.activePositions.push(newPos);
            this.tracker.addPosition(newPos, momentum.currentPrice);
            // Tandai sebagai token-side
            this.tokenSidePositions.add(newPos.positionKey.publicKey.toBase58());
            savePositions(this.activePositions);
            await this.telegram.alertPositionOpened(newPos, forcedDecision);
            console.log(`  ✅ Token-side dibuka: ${pool.name} | ${solAmount.toFixed(3)} SOL`);
        }
        else {
            console.log(`  ❌ Gagal buka token-side: ${pool.name}`);
            // Set cooldown baru supaya tidak langsung retry
            this.recentlyClosedPools.set(pool.address, Date.now());
        }
    }
    buildTokenSideCompletePrompt(status, momentum, pool) {
        return `Token-side posisi DLMM selesai (semua token → SOL). Putuskan next step.

Pool: ${status.position.poolName}
PnL total: ${status.pnlPercent.toFixed(2)}% | Fee: ${status.feeEarned.toFixed(4)} SOL
Vol/TVL: ${pool?.volumeTvlRatio?.toFixed(1) || '?'}x
Price 1h: ${momentum?.priceChange1h?.toFixed(1) || '?'}% | 24h: ${momentum?.priceChange24h?.toFixed(1) || '?'}%
Mcap: $${((momentum?.marketCap || 0) / 1000).toFixed(0)}K | Holders: ${momentum?.holders || '?'}

OPSI:
- open_position (poolAddress = alamat pool ini): Balik SOL-side di pool yang sama, harga sudah retraced cukup
- skip: Cari pool lain, pool ini sudah tidak menarik

PERTIMBANGAN:
- Balik SOL side kalau: vol/TVL masih >3x, price tidak dump >20% dari entry, pool masih aktif
- Skip kalau: momentum negatif kuat, vol/TVL rendah, pool sudah sepi

JSON: {"action":"open_position"|"skip","poolAddress":"${status.position.poolAddress}|null","strategyType":"bid_ask","binRange":${config_1.CONFIG.agent.defaultBinRange},"reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
    }
    buildClosePrompt(status, momentum, pool, hoursHeld) {
        return `Evaluasi posisi DLMM — hold, close_position, atau rebalance?

Pool: ${status.position.poolName} | Hold: ${hoursHeld.toFixed(1)}h
In range: ${status.isInRange} | PnL: ${status.pnlPercent.toFixed(2)}% | Fee: ${status.feeEarned.toFixed(4)} SOL
Vol/TVL: ${pool?.volumeTvlRatio?.toFixed(1) || '?'}x | Price 1h: ${momentum?.priceChange1h?.toFixed(1) || '?'}%
SOL in pos: ${status.totalSolInPosition?.toFixed(4)} | Token in pos: ${status.totalTokenInPosition?.toFixed(0)}

CLOSE: PnL<-${config_1.CONFIG.agent.maxLossPercent}%, out of range >2h + vol mati, hold >2h, dump >15%/1h
REBALANCE: out of range tapi vol/TVL >5x
HOLD: in range, fee mengalir, momentum positif

JSON: {"action":"hold"|"close_position"|"rebalance","reasoning":"alasan","riskLevel":"low"|"medium"|"high","confidence":0-100}`;
    }
}
exports.DLMMAgent = DLMMAgent;
//# sourceMappingURL=orchestrator.js.map