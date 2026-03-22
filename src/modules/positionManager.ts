import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  Transaction,
} from '@solana/web3.js';
import DLMM, { StrategyType, autoFillYByStrategy } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { CONFIG } from '../config';
import { StrategyDecision } from '../agent/brain';

export interface ActivePosition {
  positionKey: Keypair;
  poolAddress: string;
  poolName: string;
  entryPrice: number;
  solDeposited: number;
  openedAt: Date;
  strategyType: StrategyType;
  binRange: number;
  lastChecked: Date;
}

export interface PositionStatus {
  position: ActivePosition;
  currentValue: number;
  pnlPercent: number;
  feeEarned: number;
  isInRange: boolean;
  activeBinId: number;
}

function toStrategyType(s: string | undefined): StrategyType {
  switch (s) {
    case 'BidAsk':
    case 'BidAskImBalanced':
      return StrategyType.BidAsk;
    case 'Spot':
    case 'SPOT_PUMP':
    case 'SPOT_DUMP':
      return StrategyType.Spot;
    case 'Curve':  return StrategyType.Curve;
    case 'Spot':   return StrategyType.Spot;
    default:       return StrategyType.BidAsk; // default BidAsk untuk meme
  }
}

// Helper: handle Transaction or Transaction[]
async function sendTxOrArray(
  connection: Connection,
  txOrArray: Transaction | Transaction[],
  signers: Keypair[]
): Promise<string[]> {
  const txs = Array.isArray(txOrArray) ? txOrArray : [txOrArray];
  const sigs: string[] = [];
  for (const tx of txs) {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    sigs.push(sig);
  }
  return sigs;
}

export async function openPosition(
  connection: Connection,
  wallet: Keypair,
  poolAddress: string,
  poolName: string,
  decision: StrategyDecision,
  solAmount: number
): Promise<ActivePosition | null> {
  try {
    console.log(`\n📥 Membuka posisi di ${poolName}...`);
    console.log(`   Strategy: ${decision.strategyType} | Bin range: ±${decision.binRange || 10}`);
    console.log(`   SOL: ${solAmount}`);

    const poolPubkey = new PublicKey(poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    const activeBin = await dlmmPool.getActiveBin();
    const currentPrice = dlmmPool.fromPricePerLamport(Number(activeBin.price));
    const binRange = decision.binRange || 10;
    const strategyType = toStrategyType(decision.strategyType);

    const minBinId = activeBin.binId - binRange;
    const maxBinId = activeBin.binId + binRange;

    // LOCKED: SOL-only deposit — jangan pernah dual side
    // Token X = meme token (kita tidak punya) → 0
    // Token Y = SOL (yang kita deposit)
    const totalXAmount = new BN(0);
    const totalYAmount = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));

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

    const positionKey = new Keypair();

    // Meteora limit: max ~34 bins per tx untuk avoid InvalidRealloc
    const safeBinRange = Math.min(binRange, 34);
    const safeMinBinId = activeBin.binId - safeBinRange;
    const safeMaxBinId = activeBin.binId + safeBinRange;

    const createTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKey.publicKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { maxBinId: safeMaxBinId, minBinId: safeMinBinId, strategyType },
    });

    const sigs = await sendTxOrArray(connection, createTx as any, [wallet, positionKey]);
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
  } catch (err) {
    console.error(`❌ Gagal buka posisi di ${poolName}:`, err);
    return null;
  }
}

export async function checkPositionStatus(
  connection: Connection,
  wallet: Keypair,
  position: ActivePosition
): Promise<PositionStatus | null> {
  try {
    const poolPubkey = new PublicKey(position.poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);
    const activeBin = await dlmmPool.getActiveBin();

    const positionData = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const myPos = positionData.userPositions.find(
      (p: any) => p.publicKey.toBase58() === position.positionKey.publicKey.toBase58()
    );

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

    const feeX = Number(myPos.positionData.feeX || 0) / LAMPORTS_PER_SOL;
    const feeY = Number(myPos.positionData.feeY || 0) / LAMPORTS_PER_SOL;
    const feeEarned = feeX + feeY;

    return { position, currentValue, pnlPercent, feeEarned, isInRange, activeBinId: activeBin.binId };
  } catch (err) {
    console.error(`⚠️  Gagal cek status posisi:`, err);
    return null;
  }
}

export async function closePosition(
  connection: Connection,
  wallet: Keypair,
  position: ActivePosition
): Promise<boolean> {
  try {
    console.log(`\n📤 Menutup posisi di ${position.poolName}...`);

    const poolPubkey = new PublicKey(position.poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    const positionData = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const myPos = positionData.userPositions.find(
      (p: any) => p.publicKey.toBase58() === position.positionKey.publicKey.toBase58()
    );

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
      await sendTxOrArray(connection, claimTx as any, [wallet]);
      console.log('   💰 Fee diklaim sebelum close');
    } catch { /* non-fatal */ }

    // removeLiquidity: pakai fromBinId + toBinId + liquiditiesBpsToRemove
    // Docs resmi: https://www.npmjs.com/package/@meteora-ag/dlmm
    const binIdsToRemove = myPos.positionData.positionBinData.map((b: any) => b.binId);

    if (binIdsToRemove.length > 0) {
      const removeTx = await dlmmPool.removeLiquidity({
        position: myPos.publicKey,
        user: wallet.publicKey,
        fromBinId: binIdsToRemove[0],
        toBinId: binIdsToRemove[binIdsToRemove.length - 1],
        bps: new BN(10000), // 100% = 10000 bps
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
        });
        console.log(`   ✅ TX: ${sig}`);
      }
    }

    console.log(`   ✅ Posisi di ${position.poolName} berhasil ditutup`);
    return true;
  } catch (err) {
    console.error(`❌ Gagal tutup posisi:`, err);
    return false;
  }
}

export function formatPositionsForAI(statuses: PositionStatus[]): string {
  if (statuses.length === 0) return 'Tidak ada posisi aktif saat ini.';
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
