// Pool Discovery menggunakan Meteora Pool Discovery API
// Source: https://pool-discovery-api.datapi.meteora.ag
// Jauh lebih akurat dari /pair/all — include organic score, holders, mcap, volatility

const DISCOVERY_API = 'https://pool-discovery-api.datapi.meteora.ag';

export interface PoolInfo {
  address: string;
  name: string;
  tokenX: { mint: string; symbol: string; decimals: number };
  tokenY: { mint: string; symbol: string; decimals: number };
  binStep: number;
  feeRate: number;
  tvl: number;
  activeTvl: number;
  volume: number;
  feeWindow: number;
  feeActiveTvlRatio: number;
  volatility: number;
  organicScore: number;
  holders: number;
  marketCapUsd: number;
  priceTrend: number[];
  priceChangePct: number;
  uniqueTraders: number;
  swapCount: number;
  warnings: number;
  activePositions: number;
  poolAgeDays: number;   // umur pool dalam hari
  // Computed
  volumeTvlRatio: number;
  compositeScore: number;
  tier: 'hot' | 'warm' | 'cold';
  strategy: MemeStrategy;
  maxHoldHours: number;
  binRangeHint: number;
  poolAgeHours: number;
  feeApr24h: number;
  feeMomentumScore: number;
}

export type MemeStrategy = 'spot_pump' | 'spot_dump' | 'bidask_flip' | 'volume_surge' | 'stable_range' | 'skip';

// Filter defaults — align dengan Meridian config
const FILTERS = {
  minMcap:          150_000,   // $150K
  maxMcap:        10_000_000,  // $10M (skip yang sudah terlalu besar)
  minHolders:         500,
  minTvl:          10_000,
  maxTvl:         500_000,
  minBinStep:          80,
  maxBinStep:         125,
  minOrganic:          65,     // organic score minimum
  minFeeActiveTvlRatio: 0.02,  // 0.02% per timeframe
  timeframe:          '30m',
  category:        'trending',
};

const BLACKLIST = new Set([
  'OPTIGUY-SOL', 'GECKY-SOL', 'OPTIMUSK-SOL', // known rugs
]);

async function fetchDiscoveryAPI(pageSize = 50, extraFilters = ''): Promise<any[]> {
  const base = [
    'pool_type=dlmm',
    'base_token_has_critical_warnings=false',
    'quote_token_has_critical_warnings=false',
    'base_token_has_high_single_ownership=false',
    `base_token_market_cap>=${FILTERS.minMcap}`,
    `base_token_market_cap<=${FILTERS.maxMcap}`,
    `base_token_holders>=${FILTERS.minHolders}`,
    `tvl>=${FILTERS.minTvl}`,
    `tvl<=${FILTERS.maxTvl}`,
    `dlmm_bin_step>=${FILTERS.minBinStep}`,
    `dlmm_bin_step<=${FILTERS.maxBinStep}`,
    `base_token_organic_score>=${FILTERS.minOrganic}`,
    `fee_active_tvl_ratio>=${FILTERS.minFeeActiveTvlRatio}`,
  ];

  const filterStr = [...base, ...extraFilters ? [extraFilters] : []].join('&&');
  const url = `${DISCOVERY_API}/pools?page_size=${pageSize}&filter_by=${encodeURIComponent(filterStr)}&timeframe=${FILTERS.timeframe}&category=${FILTERS.category}`;

  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Discovery API ${res.status}`);
  const data = await res.json() as any;
  return data.data || [];
}

function detectStrategy(p: any, organic: number, feeRatio: number): {
  strategy: MemeStrategy; maxHoldHours: number; binRangeHint: number
} {
  const trend = (p.price_trend || []) as number[];
  const recentTrend = trend.slice(-3).reduce((a: number, b: number) => a + b, 0);
  const priceChange = p.pool_price_change_pct || 0;
  const volTvlRatio = p.tvl > 0 ? (p.volume || 0) / p.tvl : 0;
  const poolAgeDays = p.pool_created_at ? (Date.now() - p.pool_created_at) / (1000 * 60 * 60 * 24) : 999;

  // ── STABLE_RANGE: token sideways konsisten, fee concentrated ──────────────
  // Kondisi: harga tidak bergerak jauh, organic tinggi, vol/TVL bagus
  // Strategi: SPOT symmetric bin sempit, fee income stabil
  if (
    organic >= 80 &&
    Math.abs(priceChange) < 5 &&      // sideways ketat
    volTvlRatio >= 2 &&               // volume ada tapi tidak liar
    feeRatio > 0.08 &&                // fee income bagus
    poolAgeDays >= 3                  // pool established
  ) {
    return { strategy: 'stable_range', maxHoldHours: 6, binRangeHint: 17 };
  }

  // ── VOLUME_SURGE: volume spike tiba-tiba, fee income tinggi ───────────────
  // Kondisi: vol/TVL sangat tinggi = banyak aktivitas = fee besar
  // Strategi: BidAsk SOL-only, masuk sebelum harga bergerak jauh
  if (
    feeRatio > 0.15 &&                // fee/TVL sangat tinggi
    volTvlRatio >= 5 &&               // volume surge
    organic >= 65 &&
    Math.abs(priceChange) < 30        // belum terlalu jauh bergerak
  ) {
    return { strategy: 'volume_surge', maxHoldHours: 1, binRangeHint: 34 };
  }

  // ── BIDASK_FLIP: pool stabil, organic tinggi, fee konsisten ───────────────
  // Strategi terbaik untuk bear market — capture fee dari kedua arah
  if (
    organic >= 75 &&
    Math.abs(priceChange) < 15 &&
    feeRatio > 0.05 &&
    poolAgeDays >= 2
  ) {
    return { strategy: 'bidask_flip', maxHoldHours: 6, binRangeHint: 20 };
  }

  // ── DUMP_RECOVERY: harga turun tapi ada konfirmasi reversal ───────────────
  // IMPROVED dari spot_dump: wajib ada konfirmasi trend naik dulu
  if (
    priceChange < -20 &&              // dump signifikan
    recentTrend > 1 &&                // trend mulai naik (konfirmasi reversal)
    organic >= 60                     // masih ada organic activity
  ) {
    return { strategy: 'spot_dump', maxHoldHours: 3, binRangeHint: 30 };
  }

  // ── SPOT_PUMP: DIHAPUS sebagai default ────────────────────────────────────
  // Hanya masuk kalau ada sinyal kuat: pump + volume sangat tinggi
  if (priceChange > 10 && feeRatio > 0.12 && organic >= 65) {
    return { strategy: 'spot_pump', maxHoldHours: 1, binRangeHint: 34 };
  }

  // Default: bidask_flip (lebih aman dari spot_pump)
  return { strategy: 'bidask_flip', maxHoldHours: 4, binRangeHint: 25 };
}

function calcCompositeScore(p: PoolInfo): number {
  // Organic score (35 poin max) — filter utama
  const organicScore = Math.min(35, (p.organicScore / 100) * 35);
  // Fee/TVL ratio (30 poin max) — yield
  const feeScore = Math.min(30, p.feeActiveTvlRatio * 200);
  // Volume (20 poin max) — aktivitas
  const volScore = Math.min(20, (p.volume / 10000) * 10);
  // Holders (10 poin) — distribusi sehat
  const holderScore = Math.min(10, (p.holders / 1000) * 5);

  // Strategy bonus (5 poin) — reward strategy yang lebih efektif
  let strategyBonus = 0;
  if (p.strategy === 'stable_range') strategyBonus = 5;    // paling aman
  else if (p.strategy === 'volume_surge') strategyBonus = 4; // fee tinggi
  else if (p.strategy === 'bidask_flip') strategyBonus = 3;  // proven
  else if (p.strategy === 'spot_dump') strategyBonus = 1;    // risky
  else if (p.strategy === 'spot_pump') strategyBonus = 0;    // deprecated

  return Math.round(organicScore + feeScore + volScore + holderScore + strategyBonus);
}

function normalizePool(p: any): PoolInfo {
  const tokenX = p.token_x || {};
  const tokenY = p.token_y || {};
  const organic = Math.round(p.token_x?.organic_score || 0);
  const feeRatio = p.fee_active_tvl_ratio || 0;
  const tvl = p.tvl || 0;
  const vol = p.volume || 0;
  const volTvlRatio = tvl > 0 ? vol / tvl : 0;

  const { strategy, maxHoldHours, binRangeHint } = detectStrategy(p, organic, feeRatio);

  const pool: PoolInfo = {
    address:          p.pool_address || '',
    poolAgeDays:      p.pool_created_at ? (Date.now() - p.pool_created_at) / (1000 * 60 * 60 * 24) : 999,
    name:             p.name || '',
    tokenX: { mint: tokenX.address || '', symbol: tokenX.symbol || 'X', decimals: 9 },
    tokenY: { mint: tokenY.address || '', symbol: tokenY.symbol || 'SOL', decimals: 9 },
    binStep:          p.dlmm_params?.bin_step || 0,
    feeRate:          p.fee_pct || 0,
    tvl,
    activeTvl:        p.active_tvl || 0,
    volume:           vol,
    feeWindow:        p.fee || 0,
    feeActiveTvlRatio: feeRatio,
    volatility:       p.volatility || 0,
    organicScore:     organic,
    holders:          p.base_token_holders || 0,
    marketCapUsd:     tokenX.market_cap || 0,
    priceTrend:       p.price_trend || [],
    priceChangePct:   p.pool_price_change_pct || 0,
    uniqueTraders:    p.unique_traders || 0,
    swapCount:        p.swap_count || 0,
    warnings:         tokenX.warnings?.length || 0,
    activePositions:  p.active_positions || 0,
    volumeTvlRatio:   volTvlRatio,
    compositeScore:   0, // calculated below
    tier:             'cold',
    strategy,
    maxHoldHours,
    binRangeHint,
    poolAgeHours:     999,
    feeApr24h:        feeRatio * 48, // 30m → 24h estimate
    feeMomentumScore: Math.min(100, feeRatio * 500),
  };

  pool.compositeScore = calcCompositeScore(pool);
  pool.tier = pool.compositeScore >= 60 ? 'hot' : pool.compositeScore >= 30 ? 'warm' : 'cold';

  return pool;
}

export async function getTopPools(limit = 20): Promise<PoolInfo[]> {
  console.log(`   Fetching pools via Discovery API (organic≥${FILTERS.minOrganic}, mcap $${FILTERS.minMcap/1000}K-$${FILTERS.maxMcap/1000000}M, holders≥${FILTERS.minHolders})...`);

  let raw: any[] = [];
  try {
    // Fetch trending dengan filter ketat
    raw = await fetchDiscoveryAPI(50);
    console.log(`   Discovery API: ${raw.length} pools (filtered server-side)`);
  } catch (err) {
    console.log(`   Discovery API failed: ${err} — fallback ke pagination`);
    // Fallback ke endpoint lama
    const res = await fetch('https://dlmm-api.meteora.ag/pair/all_with_pagination?page=0&limit=50&sort_key=feetvlratio1h&order_by=desc');
    const data = await res.json() as any;
    raw = data.pairs || [];
    console.log(`   Fallback: ${raw.length} pools`);
  }

  const SOL = 'So11111111111111111111111111111111111111112';
  const pools = raw
    .map(normalizePool)
    .filter(p => {
      if (!p.address) return false;
      if (BLACKLIST.has(p.name)) return false;
      // Harus punya SOL sebagai quote token
      const hasSOL = p.tokenX.mint === SOL || p.tokenY.mint === SOL ||
        p.name.includes('-SOL') || p.name.includes('SOL-');
      if (!hasSOL) return false;
      // Skip jika ada critical warnings
      if (p.warnings > 0) return false;
      return true;
    })
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, limit);

  const hot = pools.filter(p => p.tier === 'hot').length;
  const warm = pools.filter(p => p.tier === 'warm').length;
  console.log(`   Qualified: ${pools.length} (hot: ${hot}, warm: ${warm})`);

  if (pools.length > 0) {
    const top = pools[0];
    console.log(`   Top: ${top.name} | organic:${top.organicScore} | holders:${top.holders} | fee/tvl:${top.feeActiveTvlRatio.toFixed(4)} | strategy:${top.strategy}`);
  }

  return pools;
}

export function rankPools(pools: PoolInfo[]): PoolInfo[] {
  return [...pools].sort((a, b) => b.compositeScore - a.compositeScore).slice(0, 5);
}

export function getSolAllocationMultiplier(pool: PoolInfo): number {
  if (pool.organicScore >= 85 && pool.feeActiveTvlRatio > 0.1) return 1.5;
  if (pool.tier === 'hot') return 1.25;
  return 1.0;
}

export function formatPoolsForAI(pools: PoolInfo[]): string {
  return pools.map((p, i) => `
Pool ${i+1}: ${p.name} [${p.tier.toUpperCase()}] — Strategy: ${p.strategy}
  Address: ${p.address}
  Bin Step: ${p.binStep} | Fee Rate: ${p.feeRate}%
  Organic Score: ${p.organicScore}/100 | Holders: ${p.holders.toLocaleString()} | MCap: $${(p.marketCapUsd/1000).toFixed(0)}K
  Fee/TVL Ratio: ${p.feeActiveTvlRatio.toFixed(4)} | Volume: $${p.volume.toFixed(0)}
  Volatility: ${p.volatility.toFixed(2)} | Price Change: ${p.priceChangePct.toFixed(1)}%
  Warnings: ${p.warnings} | Active Positions: ${p.activePositions}
  Composite Score: ${p.compositeScore}/100 | Max Hold: ${p.maxHoldHours}h
`).join('\n');
}

// Untuk detectStrategy export
export { detectStrategy };
