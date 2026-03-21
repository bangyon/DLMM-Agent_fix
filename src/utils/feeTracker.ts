import { Connection, Keypair } from '@solana/web3.js';
import DLMM from '@meteora-ag/dlmm';
import { PublicKey } from '@solana/web3.js';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { ActivePosition } from '../modules/positionManager';
import fs from 'fs';
import path from 'path';

export interface FeeRecord {
  timestamp: string;
  poolName: string;
  poolAddress: string;
  feeXAmount: number;
  feeYAmount: number;
  feeUsd: number;
  txSignature: string;
}

export interface CompoundStats {
  totalFeeClaimed: number;   // SOL equivalent
  totalFeeUsd: number;
  claimCount: number;
  lastClaimAt: string | null;
  positions: Record<string, { totalFee: number; claimCount: number }>;
}

const STATS_FILE = './data/fee-stats.json';

function ensureDataDir() {
  const dir = path.dirname(STATS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadStats(): CompoundStats {
  ensureDataDir();
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    }
  } catch {}
  return {
    totalFeeClaimed: 0,
    totalFeeUsd: 0,
    claimCount: 0,
    lastClaimAt: null,
    positions: {},
  };
}

function saveStats(stats: CompoundStats) {
  ensureDataDir();
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

export async function claimFees(
  connection: Connection,
  wallet: Keypair,
  position: ActivePosition
): Promise<FeeRecord | null> {
  try {
    const poolPubkey = new PublicKey(position.poolAddress);
    const dlmmPool = await DLMM.create(connection, poolPubkey);

    const positionsData = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const myPos = positionsData.userPositions.find(
      (p: any) => p.publicKey.toBase58() === position.positionKey.publicKey.toBase58()
    );

    if (!myPos) return null;

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
      sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
    }

    const record: FeeRecord = {
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
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n');

    console.log(`   💰 Fee claimed: ${(pendingFeeX / 1e9).toFixed(6)} X + ${(pendingFeeY / 1e9).toFixed(6)} Y`);
    console.log(`   TX: ${sig}`);

    return record;
  } catch (err) {
    console.error('⚠️  Claim fee gagal:', err);
    return null;
  }
}

export function getCompoundStats(): CompoundStats {
  return loadStats();
}

export function printFeeReport() {
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
