import * as fs from 'fs';

const MEMORY_FILE = 'data/pool-memory.json';

export interface PoolMemory {
  poolAddress: string;
  poolName: string;
  deploys: number;
  wins: number;        // PnL > 0 atau fee > loss
  losses: number;
  totalPnl: number;
  avgPnl: number;
  winRate: number;
  lastResult: 'win' | 'loss' | 'neutral';
  lastDeployAt: string;
  blacklisted: boolean;
  blacklistReason?: string;
}

interface PoolMemoryStore {
  [poolAddress: string]: PoolMemory;
}

function load(): PoolMemoryStore {
  try {
    fs.mkdirSync('data', { recursive: true });
    if (!fs.existsSync(MEMORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch { return {}; }
}

function save(store: PoolMemoryStore): void {
  try {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
  } catch (err) { console.error('Pool memory save error:', err); }
}

export function recordPoolResult(
  poolAddress: string,
  poolName: string,
  pnlPercent: number,
  feeEarned: number,
  closeReason: string
): void {
  const store = load();
  const existing = store[poolAddress] || {
    poolAddress,
    poolName,
    deploys: 0,
    wins: 0,
    losses: 0,
    totalPnl: 0,
    avgPnl: 0,
    winRate: 0,
    lastResult: 'neutral' as const,
    lastDeployAt: new Date().toISOString(),
    blacklisted: false,
  };

  // Win = PnL positif ATAU fee lebih dari 0.5% dari deposit
  const isWin = pnlPercent > 0 || feeEarned > 0.0005;
  const isLoss = pnlPercent < -3;

  existing.deploys += 1;
  existing.totalPnl += pnlPercent;
  existing.avgPnl = existing.totalPnl / existing.deploys;
  existing.lastDeployAt = new Date().toISOString();
  existing.poolName = poolName;

  if (isWin) {
    existing.wins += 1;
    existing.lastResult = 'win';
  } else if (isLoss) {
    existing.losses += 1;
    existing.lastResult = 'loss';
  } else {
    existing.lastResult = 'neutral';
  }

  existing.winRate = existing.deploys > 0
    ? Math.round((existing.wins / existing.deploys) * 100)
    : 0;

  // Auto-blacklist: win rate < 25% setelah minimal 3 deploy
  if (existing.deploys >= 3 && existing.winRate < 25 && existing.avgPnl < -3) {
    existing.blacklisted = true;
    existing.blacklistReason = `Win rate ${existing.winRate}% dari ${existing.deploys} deploy, avg PnL ${existing.avgPnl.toFixed(2)}%`;
    console.log(`  🚫 Pool ${poolName} auto-blacklisted: ${existing.blacklistReason}`);
  }

  store[poolAddress] = existing;
  save(store);
}

export function getPoolMemory(poolAddress: string): PoolMemory | null {
  const store = load();
  return store[poolAddress] || null;
}

export function isBlacklisted(poolAddress: string): boolean {
  const mem = getPoolMemory(poolAddress);
  return mem?.blacklisted || false;
}

export function getPoolMemorySignal(poolAddress: string): {
  skip: boolean;
  reason: string;
  confidenceBoost: number;  // positif = boost, negatif = penalize
  summary: string;
} {
  const mem = getPoolMemory(poolAddress);

  if (!mem || mem.deploys === 0) {
    return { skip: false, reason: '', confidenceBoost: 0, summary: 'Pool baru, belum ada history' };
  }

  if (mem.blacklisted) {
    return {
      skip: true,
      reason: `Blacklisted: ${mem.blacklistReason}`,
      confidenceBoost: -999,
      summary: `❌ BLACKLISTED — ${mem.deploys} deploy, win rate ${mem.winRate}%, avg PnL ${mem.avgPnl.toFixed(2)}%`,
    };
  }

  // Skip kalau win rate sangat rendah setelah cukup data
  if (mem.deploys >= 3 && mem.winRate < 30) {
    return {
      skip: true,
      reason: `Win rate rendah: ${mem.winRate}% dari ${mem.deploys} deploy`,
      confidenceBoost: -50,
      summary: `⚠️ Win rate rendah — ${mem.deploys} deploy, avg PnL ${mem.avgPnl.toFixed(2)}%`,
    };
  }

  // Confidence boost/penalize
  let boost = 0;
  if (mem.deploys >= 2) {
    if (mem.winRate >= 60) boost = +20;
    else if (mem.winRate >= 50) boost = +10;
    else if (mem.winRate < 40) boost = -10;
    else if (mem.winRate < 30) boost = -20;
  }

  const summary = `📊 History: ${mem.deploys} deploy | win ${mem.winRate}% | avg PnL ${mem.avgPnl.toFixed(2)}% | last: ${mem.lastResult}`;

  return { skip: false, reason: '', confidenceBoost: boost, summary };
}

export function formatPoolMemoryForAI(poolAddress: string): string {
  const signal = getPoolMemorySignal(poolAddress);
  return signal.summary;
}

export function getAllPoolMemory(): PoolMemory[] {
  const store = load();
  return Object.values(store).sort((a, b) => b.deploys - a.deploys);
}

export function unblacklistPool(poolAddress: string): void {
  const store = load();
  if (store[poolAddress]) {
    store[poolAddress].blacklisted = false;
    store[poolAddress].blacklistReason = undefined;
    save(store);
    console.log(`✅ Pool ${store[poolAddress].poolName} dihapus dari blacklist`);
  }
}
