"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimFees = claimFees;
exports.getCompoundStats = getCompoundStats;
exports.printFeeReport = printFeeReport;
const dlmm_1 = __importDefault(require("@meteora-ag/dlmm"));
const web3_js_1 = require("@solana/web3.js");
const web3_js_2 = require("@solana/web3.js");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const STATS_FILE = './data/fee-stats.json';
function ensureDataDir() {
    const dir = path_1.default.dirname(STATS_FILE);
    if (!fs_1.default.existsSync(dir))
        fs_1.default.mkdirSync(dir, { recursive: true });
}
function loadStats() {
    ensureDataDir();
    try {
        if (fs_1.default.existsSync(STATS_FILE)) {
            return JSON.parse(fs_1.default.readFileSync(STATS_FILE, 'utf-8'));
        }
    }
    catch { }
    return {
        totalFeeClaimed: 0,
        totalFeeUsd: 0,
        claimCount: 0,
        lastClaimAt: null,
        positions: {},
    };
}
function saveStats(stats) {
    ensureDataDir();
    fs_1.default.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}
async function claimFees(connection, wallet, position) {
    try {
        const poolPubkey = new web3_js_1.PublicKey(position.poolAddress);
        const dlmmPool = await dlmm_1.default.create(connection, poolPubkey);
        const positionsData = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
        const myPos = positionsData.userPositions.find((p) => p.publicKey.toBase58() === position.positionKey.publicKey.toBase58());
        if (!myPos)
            return null;
        // Cek apakah ada fee yang bisa diklaim
        const pendingFeeX = Number(myPos.positionData.feeX || 0);
        const pendingFeeY = Number(myPos.positionData.feeY || 0);
        if (pendingFeeX === 0 && pendingFeeY === 0) {
            return null; // Tidak ada fee
        }
        const claimTx = await dlmmPool.claimAllSwapFee({
            owner: wallet.publicKey,
            positions: [myPos],
        });
        const txs = Array.isArray(claimTx) ? claimTx : [claimTx];
        let sig = '';
        for (const tx of txs) {
            sig = await (0, web3_js_2.sendAndConfirmTransaction)(connection, tx, [wallet]);
        }
        const record = {
            timestamp: new Date().toISOString(),
            poolName: position.poolName,
            poolAddress: position.poolAddress,
            feeXAmount: pendingFeeX,
            feeYAmount: pendingFeeY,
            feeUsd: 0, // bisa di-enrich dengan price data
            txSignature: sig,
        };
        // Update stats
        const stats = loadStats();
        stats.totalFeeClaimed += (pendingFeeX + pendingFeeY) / 1e9;
        stats.claimCount++;
        stats.lastClaimAt = record.timestamp;
        if (!stats.positions[position.poolAddress]) {
            stats.positions[position.poolAddress] = { totalFee: 0, claimCount: 0 };
        }
        stats.positions[position.poolAddress].totalFee += (pendingFeeX + pendingFeeY) / 1e9;
        stats.positions[position.poolAddress].claimCount++;
        saveStats(stats);
        // Append ke log file
        const logFile = './data/fee-log.jsonl';
        fs_1.default.appendFileSync(logFile, JSON.stringify(record) + '\n');
        console.log(`   💰 Fee claimed: ${(pendingFeeX / 1e9).toFixed(6)} X + ${(pendingFeeY / 1e9).toFixed(6)} Y`);
        console.log(`   TX: ${sig}`);
        return record;
    }
    catch (err) {
        console.error('⚠️  Claim fee gagal:', err);
        return null;
    }
}
function getCompoundStats() {
    return loadStats();
}
function printFeeReport() {
    const stats = loadStats();
    console.log('\n📊 Fee Report');
    console.log('─'.repeat(40));
    console.log(`Total fee claimed: ${stats.totalFeeClaimed.toFixed(6)} SOL`);
    console.log(`Total claims: ${stats.claimCount}`);
    console.log(`Last claim: ${stats.lastClaimAt || 'Belum ada'}`);
    if (Object.keys(stats.positions).length > 0) {
        console.log('\nPer Pool:');
        for (const [addr, data] of Object.entries(stats.positions)) {
            console.log(`  ${addr.slice(0, 12)}... → ${data.totalFee.toFixed(6)} SOL (${data.claimCount}x)`);
        }
    }
}
//# sourceMappingURL=feeTracker.js.map