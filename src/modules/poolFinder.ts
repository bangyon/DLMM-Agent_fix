import { CONFIG } from '../config';

export interface PoolInfo {
  address: string;
  name: string;
  tokenX: { mint: string; symbol: string; decimals: number };
  tokenY: { mint: string; symbol: string; decimals: number };
  binStep: number;
  feeRate: number;
  tvl: number;
  volume24h: number;
  volume6h: number;
  fees24h: number;
  fees6h: number;
  feeApr24h: number;
  feeMomentumScore: number;
  compositeScore: number;
  volumeTvlRatio: number;    // KEY METRIC untuk meme: vol/TVL > 10x = hot pool
  activeBinId: number;
  currentPrice: number;
  volatility: 'low' | 'medium' | 'high';
  tier: 'hot' | 'warm' | 'cold';
  poolAgeHours: number;
  isVerified: boolean;
  marketCapUsd: number;
  liquidityUsd: number;
}

const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// MEME LP STRATEGY FILTERS (berdasarkan komunitas LP Army & top traders)
// Bukan Tokleo yang untuk bluechip — ini untuk meme hunting
// ── STRATEGY MODES (dari artikel LP Army bear market) ──────────────────────
// Mode 1: SPOT PUMP  — token sedang pump, range lebar, max hold 2 jam
// Mode 2: SPOT DUMP  — token dump >50% lalu retrace 10-20%, entry bottom
// Mode 3: BIASK FLIP — token strong >3 hari, gunakan support/resistance

const MEME_FILTERS = {
  // Token selection (dari artikel):
  // Min mcap $200K, min 500 holders, volume 50-100K per 5 menit untuk fast play
  minMarketCapUsd: 200_000,   // $200K min mcap (GMGN filter)
  minHolders: 500,            // min 500 holders
  // Vol/TVL ratio
  minVolTvlRatio: 1.0,
  hotVolTvlRatio: 10,
  warmVolTvlRatio: 2,
  // Min volume 24h
  minVolume24h: 10_000,       // $10K — filter noise
  // Min TVL
  minTvl: 10_000,             // $10K minimum
  // Bin step sweet spot
  minBinStep: 80,
  maxBinStep: 200,
  // Pool age per strategy
  minPoolAgeForBidAskFlip: 72, // 3 hari untuk BidAsk Flip (dari artikel)
  minPoolAgeHours: 0,
  minApr: 0,
};

// Detect strategy yang cocok berdasarkan kondisi pool
export type MemeStrategy = 'spot_pump' | 'spot_dump' | 'bidask_flip' | 'skip';

export function detectStrategy(pool: any): { strategy: MemeStrategy; reason: string; maxHoldHours: number; binRangeHint: number } {
  const ageHours = pool.poolAgeHours || 999;
  const priceChange1h = pool.priceChange1h || 0;
  const priceChange24h = pool.priceChange24h || 0;
  const volTvl = pool.volumeTvlRatio || 0;

  // BidAsk Flip: pool > 3 hari, volume masih ada, harga sideways/stabil
  if (ageHours >= 72 && volTvl >= 3 && Math.abs(priceChange1h) < 10) {
    return { strategy: 'bidask_flip', reason: 'Pool >3 hari, stabil, ideal untuk BidAsk Flip', maxHoldHours: 6, binRangeHint: 20 };
  }

  // Spot Dump: harga turun >50% dari ATH (proxy: 24h change < -40%)
  if (priceChange24h < -40 && priceChange1h > 5) {
    return { strategy: 'spot_dump', reason: 'Dump >40% lalu retrace — entry bottom', maxHoldHours: 3, binRangeHint: 30 };
  }

  // Spot Pump: token sedang pump (1h change positif, volume tinggi)
  if (priceChange1h > 5 && volTvl >= 5) {
    return { strategy: 'spot_pump', reason: 'Token pumping dengan volume tinggi', maxHoldHours: 2, binRangeHint: 34 };
  }

  // Default: spot pump dengan hold pendek
  if (volTvl >= 2) {
    return { strategy: 'spot_pump', reason: 'Volume ada, entry dengan range default', maxHoldHours: 2, binRangeHint: 34 };
  }

  return { strategy: 'skip', reason: 'Tidak ada strategi yang cocok', maxHoldHours: 0, binRangeHint: 0 };
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function calcFeeMomentum(fees6h: number, fees24h: number): number {
  if (fees24h === 0) return 0;
  const ratio = (fees6h / fees24h) * 4;
  return Math.min(100, Math.round(ratio * 50));
}

// Composite score khusus meme LP strategy
function calcMemeScore(
  apr: number,
  volTvlRatio: number,
  feeMomentum: number,
  binStep: number,
  poolAgeHours: number
): number {
  // 1. Volume/TVL ratio — metric utama untuk meme (40 poin max)
  const volScore = Math.min(40, volTvlRatio * 2);

  // 2. APR — fee per SOL deposited (30 poin max)
  const aprScore = Math.min(30, apr * 0.1);

  // 3. Fee momentum — apakah volume sedang naik? (20 poin max)
  const momScore = feeMomentum * 0.2;

  // 4. Bin step sweet spot untuk meme: 80-150 optimal (10 poin)
  const binScore = binStep >= 80 && binStep <= 150 ? 10 : binStep <= 200 ? 5 : 0;

  // 5. Pool age bonus: fresh runner 2-24 jam = bonus (pool baru = volume masih tinggi)
  const ageBonus = poolAgeHours >= 2 && poolAgeHours <= 24 ? 5
    : poolAgeHours <= 48 ? 3 : 0;

  return Math.round(volScore + aprScore + momScore + binScore + ageBonus);
}

function normalizePool(p: any): PoolInfo {
  const name: string = p.name || '';
  const parts = name.includes('-') ? name.split('-') : ['X', 'Y'];
  const v24h  = Number(p.volume?.hour_24 || p.trade_volume_24h || 0);
  const v6h   = Number(p.volume?.hour_6  || 0);
  const f24h  = Number(p.fees?.hour_24   || p.fees_24h || 0);
  const f6h   = Number(p.fees?.hour_6    || 0);
  const apr   = Number(p.apr || 0);
  const reserveX = Number(p.reserve_x_amount || 0);
  const reserveY = Number(p.reserve_y_amount || 0);
  const tvl   = reserveX + reserveY;
  const bs    = Number(p.bin_step || 0);

  // Volume/TVL ratio — KEY metric untuk meme
  const volTvlRatio = tvl > 0 ? v24h / tvl : 0;
  const mom   = calcFeeMomentum(f6h, f24h || apr);
  const age   = p.created_at
    ? (Date.now() - new Date(p.created_at * 1000).getTime()) / 3600000
    : 999;
  const score = calcMemeScore(apr, volTvlRatio, mom, bs, age);

  return {
    address:          p.address || '',
    name,
    tokenX: { mint: p.mint_x || '', symbol: parts[0] || 'X', decimals: 9 },
    tokenY: { mint: p.mint_y || '', symbol: parts[1] || 'Y', decimals: 6 },
    binStep:          bs,
    feeRate:          parseFloat(p.base_fee_percentage || '0') * 100,
    tvl,
    volume24h:        v24h,
    volume6h:         v6h,
    fees24h:          f24h,
    fees6h:           f6h,
    feeApr24h:        apr,
    feeMomentumScore: mom,
    compositeScore:   score,
    volumeTvlRatio:   volTvlRatio,
    activeBinId:      0,
    currentPrice:     Number(p.current_price || 0),
    volatility:       bs <= 20 ? 'low' : bs <= 80 ? 'medium' : 'high',
    tier:             score >= 60 ? 'hot' : score >= 30 ? 'warm' : 'cold',
    poolAgeHours:     age,
    isVerified:       p.is_verified || false,
    marketCapUsd:     0,
    liquidityUsd:     tvl,
  };
}

export async function getTopPools(limit = 30): Promise<PoolInfo[]> {
  console.log('   Fetching meme pools (vol/TVL ratio strategy)...');
  const raw: any[] = await fetchJson('https://dlmm-api.meteora.ag/pair/all');
  console.log(`   Total pool: ${raw.length}`);

  const pools = raw
    .map(normalizePool)
    .filter(p => {
      if (!p.address) return false;

      // Wajib SOL di salah satu sisi
      const hasSOL = p.tokenX.mint === SOL || p.tokenY.mint === SOL;
      if (!hasSOL) return false;

      // Skip stable pairs — fokus meme
      const isStable =
        [USDC, USDT].includes(p.tokenX.mint) && [USDC, USDT].includes(p.tokenY.mint);
      if (isStable) return false;

      // Bin step range untuk meme
      if (p.binStep < MEME_FILTERS.minBinStep || p.binStep > MEME_FILTERS.maxBinStep) return false;

      // Filter utama: harus ada volume
      if (p.volume24h < MEME_FILTERS.minVolume24h) return false;

      // Min TVL
      if (p.tvl < MEME_FILTERS.minTvl) return false;

      // Min vol/TVL ratio
      if (p.volumeTvlRatio < MEME_FILTERS.minVolTvlRatio) return false;

      // Skip low market cap — rug risk tinggi
      // Market cap akan di-enrich via DexScreener setelah filter awal
      // Untuk sementara: skip pool dengan TVL sangat kecil (proxy mcap)
      if (p.tvl < 10_000) return false;  // min $10K TVL = ada liquidity serius

      return true;
    })
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, limit);

  const hot  = pools.filter(p => p.tier === 'hot').length;
  const warm = pools.filter(p => p.tier === 'warm').length;
  console.log(`   Meme pools qualified: ${pools.length} (hot: ${hot}, warm: ${warm})`);

  if (pools.length > 0) {
    console.log(`   Top pool: ${pools[0].name} | vol/TVL: ${pools[0].volumeTvlRatio.toFixed(1)}x | APR: ${pools[0].feeApr24h.toFixed(0)}%`);
  }

  return pools;
}

export function rankPools(pools: PoolInfo[]): PoolInfo[] {
  return [...pools]
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, 5);
}

// LP Army allocation: hot pool = 1.5x, warm = 1x
export function getSolAllocationMultiplier(pool: PoolInfo): number {
  if (pool.tier === 'hot' && pool.volumeTvlRatio >= 20) return 1.5;
  if (pool.tier === 'hot') return 1.25;
  return 1.0;
}

export function formatPoolsForAI(pools: PoolInfo[]): string {
  return pools.map((p, i) => `
Pool ${i + 1}: ${p.name} [${p.tier.toUpperCase()}]
  Address: ${p.address}
  Bin Step: ${p.binStep}
  APR: ${p.feeApr24h.toFixed(0)}% | Volume 24h: $${p.volume24h.toLocaleString()}
  TVL: $${p.tvl.toLocaleString()} | Vol/TVL Ratio: ${p.volumeTvlRatio.toFixed(1)}x ${p.volumeTvlRatio >= 10 ? '🔥 HOT' : p.volumeTvlRatio >= 5 ? '✅ WARM' : ''}
  Fee Momentum: ${p.feeMomentumScore}/100
  Pool age: ${p.poolAgeHours === 999 ? 'unknown' : p.poolAgeHours.toFixed(1) + 'h'}
  Meme Score: ${p.compositeScore}/100
  SOL multiplier: ${getSolAllocationMultiplier(p)}x
`).join('\n');
}
