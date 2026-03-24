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
exports.openPosition = openPosition;
exports.checkPositionStatus = checkPositionStatus;
exports.closePosition = closePosition;
exports.formatPositionsForAI = formatPositionsForAI;
const web3_js_1 = require("@solana/web3.js");
const dlmm_1 = __importStar(require("@meteora-ag/dlmm"));
const bn_js_1 = __importDefault(require("bn.js"));
function toStrategyType(s) {
    switch (s) {
        case 'BidAsk':
        case 'BidAskImBalanced':
            return dlmm_1.StrategyType.BidAsk;
        case 'Curve': return dlmm_1.StrategyType.Curve;
        case 'Spot': return dlmm_1.StrategyType.Spot;
        default: return dlmm_1.StrategyType.BidAsk; // default BidAsk untuk meme
    }
}
// Helper: handle Transaction or Transaction[]
async function sendTxOrArray(connection, txOrArray, signers) {
    const txs = Array.isArray(txOrArray) ? txOrArray : [txOrArray];
    const sigs = [];
    for (const tx of txs) {
        const sig = await (0, web3_js_1.sendAndConfirmTransaction)(connection, tx, signers, {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });
        sigs.push(sig);
    }
    return sigs;
}
async function openPosition(connection, wallet, poolAddress, poolName, decision, solAmount) {
    try {
        console.log(`\n📥 Membuka posisi di ${poolName}...`);
        console.log(`   Strategy: ${decision.strategyType} | Bin range: ±${decision.binRange || 10}`);
        console.log(`   SOL: ${solAmount}`);
        const poolPubkey = new web3_js_1.PublicKey(poolAddress);
        const dlmmPool = await dlmm_1.default.create(connection, poolPubkey);
        const activeBin = await dlmmPool.getActiveBin();
        const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price));
        const binRange = decision.binRange || 10;
        const strategyType = toStrategyType(decision.strategyType);
        const minBinId = activeBin.binId - binRange;
        const maxBinId = activeBin.binId + binRange;
        // LOCKED: SOL-only deposit — jangan pernah dual side
        // Token X = meme token (kita tidak punya) → 0
        // Token Y = SOL (yang kita deposit)
        const totalXAmount = new bn_js_1.default(0);
        const totalYAmount = new bn_js_1.default(Math.floor(solAmount * web3_js_1.LAMPORTS_PER_SOL));
        console.log(`   Deposit: ${solAmount} SOL only (locked one-sided)`);
        // Pre-check: verifikasi pool masih aktif dan ada likuiditas
        const activeBinCheck = await dlmmPool.getActiveBin();
        if (!activeBinCheck || activeBinCheck.binId === 0) {
            throw new Error('Pool tidak aktif atau bin ID invalid');
        }
        // Cek apakah pool sudah punya likuiditas (ada orang lain LP di sini)
        // Pool tanpa likuiditas = kita bayar semua rent setup = mahal
        const xReserve = Number(dlmmPool.lbPair.reserveX || 0);
        const yReserve = Number(dlmmPool.lbPair.reserveY || 0);
        if (xReserve === 0 && yReserve === 0) {
            throw new Error('Pool kosong (reserve 0) — skip untuk hindari rent mahal');
        }
        const positionKey = new web3_js_1.Keypair();
        // Meteora limit: max ~34 bins per tx untuk avoid InvalidRealloc
        const safeBinRange = Math.min(binRange, 34);
        const binsBelow = safeBinRange;
        const binsAbove = strategyType === dlmm_1.StrategyType.BidAsk ? 0 : safeBinRange;
        const safeMinBinId = activeBin.binId - binsBelow;
        const safeMaxBinId = activeBin.binId + binsAbove;
        console.log(`   Bins: ${binsBelow} below + ${binsAbove} above active bin (strategy: ${strategyType === 0 ? 'Spot' : strategyType === 2 ? 'BidAsk' : 'Curve'})`);
        const createTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: positionKey.publicKey,
            user: wallet.publicKey,
            totalXAmount,
            totalYAmount,
            strategy: { maxBinId: safeMaxBinId, minBinId: safeMinBinId, strategyType },
        });
        const sigs = await sendTxOrArray(connection, createTx, [wallet, positionKey]);
        console.log(`   ✅ Posisi dibuka! TX: ${sigs[0]}`);
        console.log(`   Position key: ${positionKey.publicKey.toBase58()}`);
        return {
            positionKey,
            poolAddress,
            poolName,
            entryPrice: parseFloat(currentPrice),
            solDeposited: solAmount,
            openedAt: new Date(),
            strategyType,
            binRange,
            lastChecked: new Date(),
        };
    }
    catch (err) {
        console.error(`❌ Gagal buka posisi di ${poolName}:`, err);
        return null;
    }
}
async function checkPositionStatus(connection, wallet, position) {
    try {
        const poolPubkey = new web3_js_1.PublicKey(position.poolAddress);
        const dlmmPool = await dlmm_1.default.create(connection, poolPubkey);
        const activeBin = await dlmmPool.getActiveBin();
        const positionData = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
        const myPos = positionData.userPositions.find((p) => p.publicKey.toBase58() === position.positionKey.publicKey.toBase58());
        if (!myPos) {
            console.log(`⚠️  Posisi tidak ditemukan`);
            return null;
        }
        const minBin = myPos.positionData.lowerBinId;
        const maxBin = myPos.positionData.upperBinId;
        const isInRange = activeBin.binId >= minBin && activeBin.binId <= maxBin;
        const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price));
        const ratio = position.entryPrice > 0 ? parseFloat(currentPrice) / position.entryPrice : 1;
        const currentValue = position.solDeposited * ratio;
        const pnlPercent = ((currentValue - position.solDeposited) / position.solDeposited) * 100;
        const feeX = Number(myPos.positionData.feeX || 0) / web3_js_1.LAMPORTS_PER_SOL;
        const feeY = Number(myPos.positionData.feeY || 0) / web3_js_1.LAMPORTS_PER_SOL;
        const feeEarned = feeX + feeY;
        // Detect apakah SOL sudah terkonversi semua ke token (out of range ke kiri)
        // positionXAmount = token meme, positionYAmount = SOL
        const binData = myPos.positionData.positionBinData || [];
        const totalSolInPosition = binData.reduce((sum, b) => sum + Number(b.positionYAmount || 0), 0);
        const totalTokenInPosition = binData.reduce((sum, b) => sum + Number(b.positionXAmount || 0), 0);
        const solConvertedToToken = totalSolInPosition === 0 && totalTokenInPosition > 0;
        const tokenConvertedToSol = totalTokenInPosition === 0 && totalSolInPosition > 0;
        return {
            position, currentValue, pnlPercent, feeEarned, isInRange,
            activeBinId: activeBin.binId,
            solConvertedToToken, // true = SOL habis → semua jadi token (out of range kiri)
            tokenConvertedToSol, // true = token habis → semua jadi SOL (out of range kanan)
            totalSolInPosition: totalSolInPosition / web3_js_1.LAMPORTS_PER_SOL,
            totalTokenInPosition,
        };
    }
    catch (err) {
        console.error(`⚠️  Gagal cek status posisi:`, err);
        return null;
    }
}
async function closePosition(connection, wallet, position) {
    try {
        console.log(`\n📤 Menutup posisi di ${position.poolName}...`);
        const poolPubkey = new web3_js_1.PublicKey(position.poolAddress);
        const dlmmPool = await dlmm_1.default.create(connection, poolPubkey);
        const positionData = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
        const myPos = positionData.userPositions.find((p) => p.publicKey.toBase58() === position.positionKey.publicKey.toBase58());
        if (!myPos) {
            console.log('⚠️  Posisi tidak ditemukan (mungkin sudah closed)');
            return true;
        }
        // Claim fee dulu (non-fatal jika gagal)
        try {
            const claimTx = await dlmmPool.claimAllSwapFee({
                owner: wallet.publicKey,
                positions: [myPos],
            });
            await sendTxOrArray(connection, claimTx, [wallet]);
            console.log('   💰 Fee diklaim sebelum close');
        }
        catch { /* non-fatal */ }
        // removeLiquidity: pakai fromBinId + toBinId + liquiditiesBpsToRemove
        // Docs resmi: https://www.npmjs.com/package/@meteora-ag/dlmm
        const binIdsToRemove = myPos.positionData.positionBinData.map((b) => b.binId);
        if (binIdsToRemove.length > 0) {
            const removeTx = await dlmmPool.removeLiquidity({
                position: myPos.publicKey,
                user: wallet.publicKey,
                fromBinId: binIdsToRemove[0],
                toBinId: binIdsToRemove[binIdsToRemove.length - 1],
                bps: new bn_js_1.default(10000), // 100% = 10000 bps
                shouldClaimAndClose: true,
            });
            for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
                const sig = await (0, web3_js_1.sendAndConfirmTransaction)(connection, tx, [wallet], {
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                });
                console.log(`   ✅ TX: ${sig}`);
            }
        }
        console.log(`   ✅ Posisi di ${position.poolName} berhasil ditutup`);
        return true;
    }
    catch (err) {
        console.error(`❌ Gagal tutup posisi:`, err);
        return false;
    }
}
function formatPositionsForAI(statuses) {
    if (statuses.length === 0)
        return 'Tidak ada posisi aktif saat ini.';
    return statuses.map((s, i) => `
Posisi ${i + 1}: ${s.position.poolName}
  Pool: ${s.position.poolAddress}
  Strategy: ${s.position.strategyType} | Bin range: ±${s.position.binRange}
  SOL deposit: ${s.position.solDeposited} SOL
  Dibuka: ${s.position.openedAt.toISOString()}
  Status range: ${s.isInRange ? '✅ Dalam range' : '❌ Out of range!'}
  PnL: ${s.pnlPercent.toFixed(2)}%
  Fee earned: ${s.feeEarned.toFixed(4)} SOL
  Active bin: ${s.activeBinId}
`).join('\n');
}
//# sourceMappingURL=positionManager.js.map