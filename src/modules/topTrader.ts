// Top Trader Intelligence
// Sources:
// 1. GMGN Smart Money Leaderboard (win rate >= 80%, >= 50 positions)
// 2. LP Agent API (posisi aktif real-time)
// Strategy: detect consensus pool, pelajari pattern entry/exit, adopsi strategi

const LP_AGENT_API = 'https://api.lpagent.io/open-api/v1';

// ── GMGN Top 30 Wallets (Win Rate >= 80%, >= 50 positions) ────────────────
// Data: 22 Mar 2026 — update berkala dari GMGN leaderboard
export const GMGN_TOP_WALLETS: Record<string, { winRate: number; pnl: number; positions: number; fees: number }> = {
  // Verified 44-char wallets dari GMGN leaderboard (Win Rate >= 80%)
  // High PnL wallets — prioritas utama
  'Cu4uL12ascqxMhsaf7xuiZ2Veer5CGgmCA7PUi44cmai': { winRate: 89.39, pnl: 10151.83, positions: 68,  fees: 5535.38 }, // BEST $10K
  '6VuQKDqBpYKfug4JQkgKtck7ezLUQVPnHo9hj22i3SfD': { winRate: 84,    pnl: 4087.98,  positions: 76,  fees: 3448.82 }, // $4K
  'ETiYpqvguRMwYeJDyDqSpgDFxBhpiE8eUE3ruatTZ5Eu': { winRate: 84.78, pnl: 3953.18,  positions: 55,  fees: 5228.23 }, // $3.9K
  '6jQnCAAUs3MS46Z9UaGjSpqNzzYb3bQuQLX1ABtjeVPn': { winRate: 82.65, pnl: 1126.37,  positions: 500, fees: 1412.91 }, // $1.1K most active
  '4L2ucvfihfbERb9UL767GSFezyCtr17QPM3GFhUq98t1': { winRate: 89.47, pnl: 554.20,   positions: 707, fees: 613.88  }, // 707 pos!
  'TiRedbAFQvRBeFJvTUoWmuHxxrmMEd3GYJBawCfcZT6':  { winRate: 80.14, pnl: 439.34,   positions: 462, fees: 483.99  }, // high volume
  '6XQ5LdZuej4uNiA3CRMq78DpPsCNMyZY6Gj4azdihVNx': { winRate: 92,    pnl: 433.86,   positions: 71,  fees: 452.78  }, // 92% WR
  '93nYRmQD7oHQmAQi32KznrwohPmXSWJuNgGPQx8UZJdw': { winRate: 81.63, pnl: 350.66,   positions: 80,  fees: 346.57  },
  'BqEw8xC6SAFv7w6RQsn8gCyDDbH9ohs4hQqQbB3VTmvj': { winRate: 83.33, pnl: 224.84,   positions: 85,  fees: 365.80  },
  'BvDEvvuSP8jWUCfs6JUohEZ1QJicknYk5EExxFsKLAUn': { winRate: 84.09, pnl: 223.47,   positions: 141, fees: 229.19  },
  'DPYCLRkA9Fzp69Jv24ukx9pm67uqtZ4PcmUWBHXJwhhs': { winRate: 81.40, pnl: 182.63,   positions: 369, fees: 227.74  },
  'BmiQACogSergeSf6CMVRw4LQpE8VPkvyukAyHxzDR32A': { winRate: 84.21, pnl: 125.25,   positions: 129, fees: 122.36  },
  '4JGMtsF1VhaKgH68Qf8jiXrxi176f72Q3ZcKmHDBuRRG': { winRate: 81.58, pnl: 106.72,   positions: 79,  fees: 729.23  },
  'H1fGeczQMWUPFeuXpqfeRxuUK3QwQdW39zGfvkge9PR6': { winRate: 83.33, pnl: 61.62,    positions: 421, fees: 94.03   },
  'Ao5bLHGmE9MMKib1fni7hVs3jfk7UzmQopxxLp4sLrzg': { winRate: 88.89, pnl: 76.83,    positions: 428, fees: 95.37   },
};

// TOP_TRADER_WALLETS: hanya GMGN verified wallets dengan PnL > $100
// LP Agent wallets dihapus — semua inactive saat dicek
// Wallet diupdate secara berkala dari GMGN leaderboard
export const TOP_TRADER_WALLETS = [
  'Cu4uL12ascqxMhsaf7xuiZ2Veer5CGgmCA7PUi44cmai',  // $10,151 PnL, 89% WR ⭐
  '6VuQKDqBpYKfug4JQkgKtck7ezLUQVPnHo9hj22i3SfD',  // $4,087 PnL, 84% WR
  'ETiYpqvguRMwYeJDyDqSpgDFxBhpiE8eUE3ruatTZ5Eu',  // $3,953 PnL, 84% WR
  '6jQnCAAUs3MS46Z9UaGjSpqNzzYb3bQuQLX1ABtjeVPn',  // $1,126 PnL, 82% WR, 500 pos
  '4L2ucvfihfbERb9UL767GSFezyCtr17QPM3GFhUq98t1',  // $554 PnL, 89% WR, 707 pos
  'TiRedbAFQvRBeFJvTUoWmuHxxrmMEd3GYJBawCfcZT6',   // $439 PnL, 80% WR
  '6XQ5LdZuej4uNiA3CRMq78DpPsCNMyZY6Gj4azdihVNx',  // $433 PnL, 92% WR
  '93nYRmQD7oHQmAQi32KznrwohPmXSWJuNgGPQx8UZJdw',  // $350 PnL, 81% WR
  'BqEw8xC6SAFv7w6RQsn8gCyDDbH9ohs4hQqQbB3VTmvj',  // $224 PnL, 83% WR
  'BvDEvvuSP8jWUCfs6JUohEZ1QJicknYk5EExxFsKLAUn',  // $223 PnL, 84% WR
  'DPYCLRkA9Fzp69Jv24ukx9pm67uqtZ4PcmUWBHXJwhhs',  // $182 PnL, 81% WR
  'B8HvSBJVGAiDQPSwypAAkP8qni59Rgnmi2c7oLKqFXGW',  // $198 PnL, 100% WR
  'BmiQACogSergeSf6CMVRw4LQpE8VPkvyukAyHxzDR32A',  // $125 PnL, 84% WR
  '4JGMtsF1VhaKgH68Qf8jiXrxi176f72Q3ZcKmHDBuRRG',  // $106 PnL, 81% WR
  // Update wallet baru: buka GMGN leaderboard, tambahkan wallet aktif di sini
];

export interface TraderPosition {
  wallet: string;
  walletLabel: string;  // GMGN rank / LP Agent label
  pool: string;
  pairName: string;
  strategyType: string;
  inRange: boolean;
  pnlPercent: number;
  ageHours: number;
  dprNative: number;
  binRange: number;
  currentValue: number;
  inputValue: number;
  collectedFeeNative: number;
  // GMGN trader stats
  traderWinRate: number;
  traderPnl: number;
}

export interface PoolConsensus {
  pool: string;
  pairName: string;
  traderCount: number;
  traders: string[];
  positions: TraderPosition[];
  dominantStrategy: string;
  avgBinRange: number;
  avgPnlPercent: number;
  avgDpr: number;
  totalValueUsd: number;
  consensusScore: number;
  signal: 'strong_entry' | 'entry' | 'watch' | 'avoid';
  traderExiting: number;
  // Weighted by GMGN trader quality
  weightedScore: number;
}

export interface TraderIntelligence {
  pools: Map<string, PoolConsensus>;
  topPools: PoolConsensus[];
  activeTraderCount: number;
  totalPositions: number;
  lastFetched: Date;
  patterns: {
    avgHoldHours: number;
    preferredStrategy: string;
    avgBinRange: number;
    winRate: number;
  };
}

async function fetchJson(url: string, apiKey: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// State untuk tracking inactive wallets
const inactiveWallets = new Map<string, number>(); // wallet -> first inactive timestamp
let activeWalletList = [...TOP_TRADER_WALLETS];    // mutable list, wallets pruned over time

async function fetchWalletPositions(wallet: string, apiKey: string): Promise<TraderPosition[]> {
  try {
    const data = await fetchJson(
      `${LP_AGENT_API}/lp-positions/opening?owner=${wallet}`,
      apiKey
    );
    if (data.status !== 'success' || !data.data) return [];

    const gmgnStats = GMGN_TOP_WALLETS[wallet];
    const label = gmgnStats
      ? `GMGN#${Object.keys(GMGN_TOP_WALLETS).indexOf(wallet)+1} WR${gmgnStats.winRate}% $${gmgnStats.pnl}`
      : 'LP Agent';

    return data.data
      .filter((p: any) => !p.protocol || p.protocol === 'meteora')
      .map((p: any) => {
        const r = p.range || [];
        const binRange = r.length >= 2 ? Math.round(Math.abs(r[1] - r[0]) / 2) : 34;
        return {
          wallet,
          walletLabel: label,
          pool: p.pool || '',
          pairName: p.pairName || `${p.tokenName0}-${p.tokenName1 || 'SOL'}`,
          strategyType: p.strategyType || 'Unknown',
          inRange: p.inRange || false,
          pnlPercent: p.pnl?.percent || 0,
          ageHours: parseFloat(p.age || '0'),
          dprNative: parseFloat(p.dprNative || '0'),
          binRange,
          currentValue: parseFloat(p.currentValue || '0'),
          inputValue: parseFloat(p.inputValue || '0'),
          collectedFeeNative: p.collectedFeeNative || 0,
          traderWinRate: gmgnStats?.winRate || 70,
          traderPnl: gmgnStats?.pnl || 0,
        } as TraderPosition;
      })
      .filter((p: TraderPosition) => p.pool);
  } catch { return []; }
}

export async function buildTraderIntelligence(apiKey: string): Promise<TraderIntelligence> {
  if (!apiKey) return emptyIntelligence();

  console.log(`\n🧠 Fetching ${activeWalletList.length}/${TOP_TRADER_WALLETS.length} top trader positions...`);

  const results = await Promise.allSettled(
    activeWalletList.map(w => fetchWalletPositions(w, apiKey))
  );

  const allPositions: TraderPosition[] = [];
  let activeCount = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      allPositions.push(...r.value);
      activeCount++;
    }
  }

  console.log(`   Active: ${activeCount}/${TOP_TRADER_WALLETS.length} | Positions: ${allPositions.length}`);

  // Auto-prune: track inactive wallets
  // Wallet yang tidak punya posisi aktif dicatat waktu pertama kali inactive
  const now = Date.now();
  for (let i = 0; i < results.length; i++) {
    const wallet = TOP_TRADER_WALLETS[i];
    const result = results[i];
    const hasPositions = result.status === 'fulfilled' && result.value.length > 0;
    if (!hasPositions) {
      // Catat kapan pertama kali inactive
      if (!inactiveWallets.has(wallet)) {
        inactiveWallets.set(wallet, now);
      }
    } else {
      // Reset kalau aktif lagi
      inactiveWallets.delete(wallet);
    }
  }

  // Prune wallet inactive > 36 jam
  const MAX_INACTIVE_MS = 36 * 3600 * 1000;
  let pruned = 0;
  for (const [wallet, firstInactiveAt] of inactiveWallets.entries()) {
    if (now - firstInactiveAt > MAX_INACTIVE_MS) {
      const idx = activeWalletList.indexOf(wallet);
      if (idx >= 0) {
        activeWalletList.splice(idx, 1);
        inactiveWallets.delete(wallet);
        pruned++;
        console.log(`   🗑️  Pruned inactive wallet: ${wallet.slice(0,8)}... (inactive > 36h)`);
      }
    }
  }
  if (pruned > 0) console.log(`   Remaining wallets: ${activeWalletList.length}`);

  // Build consensus map
  const poolMap = new Map<string, { positions: TraderPosition[]; traders: Set<string> }>();
  for (const pos of allPositions) {
    if (!poolMap.has(pos.pool)) poolMap.set(pos.pool, { positions: [], traders: new Set() });
    const e = poolMap.get(pos.pool)!;
    e.positions.push(pos);
    e.traders.add(pos.wallet);
  }

  const consensusMap = new Map<string, PoolConsensus>();
  for (const [pool, data] of poolMap) {
    const positions = data.positions;
    const traderCount = data.traders.size;

    const strategies = positions.map(p => p.strategyType).filter(s => s && s !== 'Unknown');
    const stratFreq = strategies.reduce((a, s) => { a[s] = (a[s]||0)+1; return a; }, {} as Record<string,number>);
    const dominantStrategy = Object.entries(stratFreq).sort(([,a],[,b]) => b-a)[0]?.[0] || 'BidAskImBalanced';

    const avgBinRange = Math.round(positions.reduce((s, p) => s + p.binRange, 0) / positions.length);
    const avgPnl = positions.reduce((s, p) => s + p.pnlPercent, 0) / positions.length;
    const avgDpr = positions.reduce((s, p) => s + p.dprNative, 0) / positions.length;
    const totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
    const traderExiting = positions.filter(p => p.pnlPercent < -2).length;

    // Weighted score: GMGN high-PnL traders count more
    const avgWinRate = positions.reduce((s, p) => s + p.traderWinRate, 0) / positions.length;
    const qualityMult = avgWinRate >= 90 ? 2 : avgWinRate >= 85 ? 1.5 : 1;
    const traderScore = Math.min(60, traderCount * 20) * qualityMult;
    const pnlScore = Math.min(25, Math.max(0, avgPnl * 2));
    const dprScore = Math.min(15, avgDpr * 50);
    const consensusScore = Math.round(Math.min(100, traderScore + pnlScore + dprScore));
    const weightedScore = consensusScore * (avgWinRate / 80);

    const signal: PoolConsensus['signal'] =
      traderCount >= 3 && avgWinRate >= 85 ? 'strong_entry' :
      traderCount >= 2 && avgPnl > 0 ? 'entry' :
      traderCount >= 2 ? 'watch' : 'avoid';

    consensusMap.set(pool, {
      pool, pairName: positions[0].pairName, traderCount,
      traders: Array.from(data.traders), positions,
      dominantStrategy, avgBinRange, avgPnlPercent: avgPnl,
      avgDpr, totalValueUsd: totalValue,
      consensusScore, signal, traderExiting, weightedScore,
    });
  }

  const topPools = Array.from(consensusMap.values())
    .filter(p => p.traderCount >= 2)
    .sort((a, b) => b.weightedScore - a.weightedScore);

  if (topPools.length > 0) {
    console.log(`\n   🎯 Pool consensus (GMGN + LP Agent):`);
    for (const p of topPools.slice(0, 5)) {
      const e = p.signal === 'strong_entry' ? '🔥' : p.signal === 'entry' ? '✅' : '👀';
      console.log(`   ${e} ${p.pairName} — ${p.traderCount} traders | PnL ${p.avgPnlPercent.toFixed(1)}% | ${p.dominantStrategy} | ±${p.avgBinRange} bins | score ${p.weightedScore.toFixed(0)}`);
    }
  }

  const profitable = allPositions.filter(p => p.pnlPercent > 0);
  const patterns = {
    avgHoldHours: profitable.length > 0
      ? profitable.reduce((s, p) => s + p.ageHours, 0) / profitable.length : 4,
    preferredStrategy: 'BidAskImBalanced',
    avgBinRange: profitable.length > 0
      ? Math.round(profitable.reduce((s, p) => s + p.binRange, 0) / profitable.length) : 40,
    winRate: allPositions.length > 0
      ? (profitable.length / allPositions.length) * 100 : 0,
  };

  console.log(`   📊 Patterns: ${patterns.preferredStrategy} | bin ±${patterns.avgBinRange} | win ${patterns.winRate.toFixed(0)}% | hold ${patterns.avgHoldHours.toFixed(1)}h`);

  return { pools: consensusMap, topPools, activeTraderCount: activeCount, totalPositions: allPositions.length, lastFetched: new Date(), patterns };
}

export function getPoolConsensus(intel: TraderIntelligence, pool: string): PoolConsensus | null {
  return intel.pools.get(pool) || null;
}

export function detectExitSignals(intel: TraderIntelligence, pool: string): { isExiting: boolean; reason: string } {
  const c = intel.pools.get(pool);
  if (!c) return { isExiting: false, reason: '' };
  if (c.traderExiting >= 2) return { isExiting: true, reason: `${c.traderExiting} top traders PnL negatif — exit signal` };
  if (c.avgPnlPercent < -5) return { isExiting: true, reason: `Avg PnL top traders ${c.avgPnlPercent.toFixed(1)}%` };
  return { isExiting: false, reason: '' };
}

export function formatIntelligenceForAI(intel: TraderIntelligence): string {
  if (intel.totalPositions === 0) return 'Intelligence: Semua top traders sedang tidak aktif';

  const topText = intel.topPools.slice(0, 5).map((p, i) => {
    const e = p.signal === 'strong_entry' ? '🔥' : p.signal === 'entry' ? '✅' : '👀';
    const traders = p.traders.slice(0, 3).map(w => {
      const g = GMGN_TOP_WALLETS[w];
      return g ? `WR${g.winRate}%` : 'LP';
    }).join(', ');
    return `${i+1}. ${e} ${p.pairName} [${p.pool.slice(0,8)}...]
   ${p.traderCount} top traders (${traders})
   Strategy: ${p.dominantStrategy} | Bin: ±${p.avgBinRange}
   Avg PnL: ${p.avgPnlPercent.toFixed(2)}% | DPR: ${(p.avgDpr*100).toFixed(2)}%/hari
   Weighted Score: ${p.weightedScore.toFixed(0)}/100
   ${p.traderExiting > 0 ? `⚠️ ${p.traderExiting} trader negatif` : ''}`;
  }).join('\n\n');

  return `=== GMGN + LP AGENT INTELLIGENCE (${intel.activeTraderCount} traders aktif) ===
Sumber: 30 GMGN Smart Money (WR 80-100%) + 8 LP Agent Smart LP
Total posisi dipantau: ${intel.totalPositions} | ${intel.lastFetched.toLocaleTimeString('id-ID')}

Learned patterns dari top traders:
- Strategy: ${intel.patterns.preferredStrategy}
- Avg bin range: ±${intel.patterns.avgBinRange}
- Avg hold time: ${intel.patterns.avgHoldHours.toFixed(1)} jam
- Win rate posisi aktif: ${intel.patterns.winRate.toFixed(0)}%

Pool dengan multiple top traders:
${topText || 'Tidak ada consensus pool saat ini'}

INSTRUKSI KEPUTUSAN:
- Pool dengan 3+ GMGN traders (WR>85%) = STRONG SIGNAL → override semua pertimbangan lain
- Adopsi PERSIS strategy dan bin range yang dipakai top traders
- Pool tidak di consensus list = andalkan vol/TVL + momentum`;
}

function emptyIntelligence(): TraderIntelligence {
  return {
    pools: new Map(), topPools: [], activeTraderCount: 0,
    totalPositions: 0, lastFetched: new Date(),
    patterns: { avgHoldHours: 4, preferredStrategy: 'BidAskImBalanced', avgBinRange: 40, winRate: 0 },
  };
}
