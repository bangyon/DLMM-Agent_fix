import { CONFIG } from '../config';

export interface BacktestConfig {
  poolAddress: string;
  poolName: string;
  strategyType: 'Spot' | 'Curve' | 'BidAsk';
  binRange: number;
  initialSol: number;
  daysBack: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  totalDays: number;
  hoursInRange: number;
  hoursOutRange: number;
  inRangePercent: number;
  totalFeeEarned: number;
  feeApr: number;
  estimatedIL: number;
  netReturn: number;
  bestBinRange: number;
  verdict: 'excellent' | 'good' | 'mediocre' | 'poor';
  summary: string;
  dataSource: 'live' | 'mock';
}

interface PriceCandle {
  timestamp: number;
  price: number;
  volume: number;
}

// Fetch harga historis dari Birdeye API (tidak butuh key untuk public tokens)
async function fetchPriceHistory(mint: string, daysBack: number): Promise<PriceCandle[]> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - daysBack * 86400;

  // Coba Birdeye public endpoint
  const url = `https://public-api.birdeye.so/defi/history_price?address=${mint}&address_type=token&type=1H&time_from=${from}&time_to=${to}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Birdeye HTTP ${res.status}`);

  const data = await res.json() as any;
  const items: any[] = data?.data?.items || [];
  if (items.length === 0) throw new Error('No price data from Birdeye');

  return items.map((d: any) => ({
    timestamp: d.unixTime * 1000,
    price: d.value,
    volume: 0,
  }));
}

// Fallback: generate mock berdasarkan volatility yang realistis
function generateMockCandles(daysBack: number, volatilityPct: number): PriceCandle[] {
  const candles: PriceCandle[] = [];
  const hours = daysBack * 24;
  let price = 100;

  for (let i = 0; i < hours; i++) {
    // Realistic random walk
    const change = (Math.random() - 0.5) * volatilityPct * 2;
    price = Math.max(price * (1 + change / 100), 0.001);
    candles.push({
      timestamp: Date.now() - (hours - i) * 3600000,
      price,
      volume: Math.random() * 10000 + 500,
    });
  }
  return candles;
}

// Simulasi posisi: hitung berapa % waktu dalam range
function simulatePosition(
  candles: PriceCandle[],
  binStep: number,
  binRange: number
): { hoursInRange: number; hoursOutRange: number; estimatedIL: number } {
  if (candles.length === 0) return { hoursInRange: 0, hoursOutRange: 0, estimatedIL: 0 };

  const entryPrice = candles[0].price;
  // Hitung range price dari bin range & bin step
  // Setiap bin = (1 + binStep/10000) kali harga sebelumnya
  const binFactor = Math.pow(1 + binStep / 10000, binRange);
  const minPrice = entryPrice / binFactor;
  const maxPrice = entryPrice * binFactor;

  let hoursInRange = 0;
  let hoursOutRange = 0;

  for (const candle of candles) {
    if (candle.price >= minPrice && candle.price <= maxPrice) {
      hoursInRange++;
    } else {
      hoursOutRange++;
    }
  }

  // IL berdasarkan perubahan harga akhir vs awal
  const priceRatio = candles[candles.length - 1].price / entryPrice;
  const il = Math.abs(2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1) * 100;

  return { hoursInRange, hoursOutRange, estimatedIL: il };
}

// Hitung optimal bin range: cari range agar 90% waktu in-range
function findOptimalBinRange(candles: PriceCandle[], binStep: number): number {
  if (candles.length === 0 || binStep === 0) return 10;
  const entryPrice = candles[0].price;
  const prices = candles.map(c => c.price);
  const maxRatio = Math.max(...prices) / entryPrice;
  const minRatio = entryPrice / Math.min(...prices);
  const worstRatio = Math.max(maxRatio, minRatio);
  // Bins needed = log(worstRatio) / log(1 + binStep/10000)
  const binsNeeded = Math.ceil(Math.log(worstRatio) / Math.log(1 + binStep / 10000));
  return Math.max(5, Math.min(binsNeeded, 50));
}

export async function runBacktest(config: BacktestConfig): Promise<BacktestResult> {
  console.log(`\n🧪 Backtesting: ${config.poolName}`);
  console.log(`   Strategy: ${config.strategyType} | Bin range: ±${config.binRange} | ${config.daysBack} hari`);

  // Tentukan mint yang mau diambil harganya
  // Kita tidak punya mint di BacktestConfig, pakai mock untuk sekarang
  let candles: PriceCandle[] = [];
  let dataSource: 'live' | 'mock' = 'mock';

  // Volatilitas per tipe strategy
  const volatilityMap = { Spot: 1, Curve: 4, BidAsk: 12 };
  const vol = volatilityMap[config.strategyType];

  candles = generateMockCandles(config.daysBack, vol);
  console.log(`   ℹ️  Menggunakan simulasi harga (data historis tidak tersedia untuk pool ini)`);

  const binStep = config.strategyType === 'Spot' ? 5
    : config.strategyType === 'Curve' ? 25 : 80;

  const { hoursInRange, hoursOutRange, estimatedIL } = simulatePosition(candles, binStep, config.binRange);
  const totalHours = candles.length;
  const inRangePercent = (hoursInRange / totalHours) * 100;

  // Fee APR: proporsi waktu in-range × estimasi APR pool
  // Kita tidak tahu APR pool di sini, gunakan multiplier dari strategy
  const baseApr = config.strategyType === 'Spot' ? 30
    : config.strategyType === 'Curve' ? 80 : 150;
  const feeApr = baseApr * (inRangePercent / 100);
  const totalFeeEarned = config.initialSol * (feeApr / 100) * (config.daysBack / 365);

  const netReturn = feeApr - estimatedIL;
  const bestBinRange = findOptimalBinRange(candles, binStep);

  const verdict: BacktestResult['verdict'] = netReturn > 100 ? 'excellent'
    : netReturn > 30 ? 'good'
    : netReturn > 0 ? 'mediocre' : 'poor';

  const summary = buildSummary(inRangePercent, feeApr, estimatedIL, netReturn, bestBinRange, config.binRange);

  const result: BacktestResult = {
    config, totalDays: config.daysBack,
    hoursInRange, hoursOutRange, inRangePercent,
    totalFeeEarned, feeApr, estimatedIL, netReturn,
    bestBinRange, verdict, summary, dataSource,
  };

  printResult(result);
  return result;
}

function buildSummary(
  inRangePercent: number,
  feeApr: number,
  il: number,
  netReturn: number,
  bestRange: number,
  usedRange: number
): string {
  const lines: string[] = [];
  if (inRangePercent < 60) {
    lines.push(`Posisi hanya in-range ${inRangePercent.toFixed(0)}% waktu — pertimbangkan perlebar range ke ±${bestRange}.`);
  } else {
    lines.push(`Posisi in-range ${inRangePercent.toFixed(0)}% waktu.`);
  }
  if (feeApr > 50) lines.push(`Fee APR estimasi ${feeApr.toFixed(1)}%.`);
  if (il > 5) lines.push(`⚠️  Estimasi IL ${il.toFixed(1)}% — hati-hati volatilitas.`);
  if (bestRange !== usedRange) lines.push(`Optimal bin range: ±${bestRange} (kamu pakai ±${usedRange}).`);
  lines.push(`Net return estimasi: ${netReturn.toFixed(1)}%.`);
  return lines.join(' ');
}

function printResult(r: BacktestResult) {
  const e = { excellent: '🏆', good: '✅', mediocre: '⚠️', poor: '❌' }[r.verdict];
  console.log(`\n   ${e} Hasil Backtest (${r.totalDays} hari) [${r.dataSource}]`);
  console.log(`   In range: ${r.inRangePercent.toFixed(1)}% waktu`);
  console.log(`   Fee APR estimasi: ${r.feeApr.toFixed(1)}%`);
  console.log(`   Estimasi IL: ${r.estimatedIL.toFixed(1)}%`);
  console.log(`   Net return: ${r.netReturn.toFixed(1)}%`);
  console.log(`   Optimal bin range: ±${r.bestBinRange}`);
  console.log(`   💬 ${r.summary}`);
}

export async function comparePoolBacktests(
  pools: Array<{ address: string; name: string; binStep: number }>,
  daysBack = 7
): Promise<BacktestResult[]> {
  console.log(`\n🧪 Membandingkan ${pools.length} pool (${daysBack} hari backtest)...`);

  const results: BacktestResult[] = [];
  for (const pool of pools) {
    const strategy: 'Spot' | 'Curve' | 'BidAsk' =
      pool.binStep > 80 ? 'BidAsk' : pool.binStep > 20 ? 'Curve' : 'Spot';
    const binRange = pool.binStep > 80 ? 30 : pool.binStep > 20 ? 20 : 10;

    const result = await runBacktest({
      poolAddress: pool.address,
      poolName: pool.name,
      strategyType: strategy,
      binRange,
      initialSol: 0.1,
      daysBack,
    });
    results.push(result);
  }

  results.sort((a, b) => b.netReturn - a.netReturn);

  console.log('\n📊 Ranking Pool (estimasi):');
  results.forEach((r, i) => {
    const e = { excellent: '🏆', good: '✅', mediocre: '⚠️', poor: '❌' }[r.verdict];
    console.log(`${i + 1}. ${e} ${r.config.poolName} — APR: ${r.feeApr.toFixed(1)}% | Net: ${r.netReturn.toFixed(1)}%`);
  });

  console.log('\n⚠️  Catatan: angka di atas adalah estimasi simulasi, bukan jaminan profit.');
  console.log('   Selalu mulai dengan SOL kecil dan monitor posisi secara berkala.');

  return results;
}
