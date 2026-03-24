"use strict";
// Pool Discovery menggunakan Meteora Pool Discovery API
// Source: https://pool-discovery-api.datapi.meteora.ag
// Jauh lebih akurat dari /pair/all — include organic score, holders, mcap, volatility
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTopPools = getTopPools;
exports.rankPools = rankPools;
exports.getSolAllocationMultiplier = getSolAllocationMultiplier;
exports.formatPoolsForAI = formatPoolsForAI;
exports.detectStrategy = detectStrategy;
const DISCOVERY_API = 'https://pool-discovery-api.datapi.meteora.ag';
// Filter defaults — align dengan Meridian config
const FILTERS = {
    minMcap: 150000, // $150K
    maxMcap: 10000000, // $10M (skip yang sudah terlalu besar)
    minHolders: 500,
    minTvl: 10000,
    maxTvl: 500000,
    minBinStep: 80,
    maxBinStep: 125,
    minOrganic: 65, // organic score minimum
    minFeeActiveTvlRatio: 0.02, // 0.02% per timeframe
    timeframe: '30m',
    category: 'trending',
};
const BLACKLIST = new Set([
    'OPTIGUY-SOL', 'GECKY-SOL', 'OPTIMUSK-SOL', // known rugs
]);
async function fetchDiscoveryAPI(pageSize = 50, extraFilters = '') {
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
    if (!res.ok)
        throw new Error(`Discovery API ${res.status}`);
    const data = await res.json();
    return data.data || [];
}
function detectStrategy(p, organic, feeRatio) {
    const trend = (p.price_trend || []);
    const recentTrend = trend.slice(-3).reduce((a, b) => a + b, 0);
    const priceChange = p.pool_price_change_pct || 0;
    // BidAsk Flip: organic tinggi, volume stabil, tidak sedang pump/dump
    if (organic >= 75 && Math.abs(priceChange) < 15 && feeRatio > 0.05) {
        return { strategy: 'bidask_flip', maxHoldHours: 6, binRangeHint: 20 };
    }
    // Spot Dump: price turun tapi mulai recovery (trend naik dari bawah)
    if (priceChange < -20 && recentTrend > 0) {
        return { strategy: 'spot_dump', maxHoldHours: 3, binRangeHint: 30 };
    }
    // Spot Pump: price naik, volume tinggi
    if (priceChange > 5 || feeRatio > 0.1) {
        return { strategy: 'spot_pump', maxHoldHours: 2, binRangeHint: 34 };
    }
    return { strategy: 'spot_pump', maxHoldHours: 2, binRangeHint: 34 };
}
function calcCompositeScore(p) {
    // Organic score (40 poin max) — filter utama
    const organicScore = Math.min(40, (p.organicScore / 100) * 40);
    // Fee/TVL ratio (30 poin max) — yield
    const feeScore = Math.min(30, p.feeActiveTvlRatio * 200);
    // Volume (20 poin max) — aktivitas
    const volScore = Math.min(20, (p.volume / 10000) * 10);
    // Holders (10 poin) — distribusi sehat
    const holderScore = Math.min(10, (p.holders / 1000) * 5);
    return Math.round(organicScore + feeScore + volScore + holderScore);
}
function normalizePool(p) {
    const tokenX = p.token_x || {};
    const tokenY = p.token_y || {};
    const organic = Math.round(p.token_x?.organic_score || 0);
    const feeRatio = p.fee_active_tvl_ratio || 0;
    const tvl = p.tvl || 0;
    const vol = p.volume || 0;
    const volTvlRatio = tvl > 0 ? vol / tvl : 0;
    const { strategy, maxHoldHours, binRangeHint } = detectStrategy(p, organic, feeRatio);
    const pool = {
        address: p.pool_address || '',
        name: p.name || '',
        tokenX: { mint: tokenX.address || '', symbol: tokenX.symbol || 'X', decimals: 9 },
        tokenY: { mint: tokenY.address || '', symbol: tokenY.symbol || 'SOL', decimals: 9 },
        binStep: p.dlmm_params?.bin_step || 0,
        feeRate: p.fee_pct || 0,
        tvl,
        activeTvl: p.active_tvl || 0,
        volume: vol,
        feeWindow: p.fee || 0,
        feeActiveTvlRatio: feeRatio,
        volatility: p.volatility || 0,
        organicScore: organic,
        holders: p.base_token_holders || 0,
        marketCapUsd: tokenX.market_cap || 0,
        priceTrend: p.price_trend || [],
        priceChangePct: p.pool_price_change_pct || 0,
        uniqueTraders: p.unique_traders || 0,
        swapCount: p.swap_count || 0,
        warnings: tokenX.warnings?.length || 0,
        activePositions: p.active_positions || 0,
        volumeTvlRatio: volTvlRatio,
        compositeScore: 0, // calculated below
        tier: 'cold',
        strategy,
        maxHoldHours,
        binRangeHint,
        poolAgeHours: 999,
        feeApr24h: feeRatio * 48, // 30m → 24h estimate
        feeMomentumScore: Math.min(100, feeRatio * 500),
    };
    pool.compositeScore = calcCompositeScore(pool);
    pool.tier = pool.compositeScore >= 60 ? 'hot' : pool.compositeScore >= 30 ? 'warm' : 'cold';
    return pool;
}
async function getTopPools(limit = 20) {
    console.log(`   Fetching pools via Discovery API (organic≥${FILTERS.minOrganic}, mcap $${FILTERS.minMcap / 1000}K-$${FILTERS.maxMcap / 1000000}M, holders≥${FILTERS.minHolders})...`);
    let raw = [];
    try {
        // Fetch trending dengan filter ketat
        raw = await fetchDiscoveryAPI(50);
        console.log(`   Discovery API: ${raw.length} pools (filtered server-side)`);
    }
    catch (err) {
        console.log(`   Discovery API failed: ${err} — fallback ke pagination`);
        // Fallback ke endpoint lama
        const res = await fetch('https://dlmm-api.meteora.ag/pair/all_with_pagination?page=0&limit=50&sort_key=feetvlratio1h&order_by=desc');
        const data = await res.json();
        raw = data.pairs || [];
        console.log(`   Fallback: ${raw.length} pools`);
    }
    const SOL = 'So11111111111111111111111111111111111111112';
    const pools = raw
        .map(normalizePool)
        .filter(p => {
        if (!p.address)
            return false;
        if (BLACKLIST.has(p.name))
            return false;
        // Harus punya SOL sebagai quote token
        const hasSOL = p.tokenX.mint === SOL || p.tokenY.mint === SOL ||
            p.name.includes('-SOL') || p.name.includes('SOL-');
        if (!hasSOL)
            return false;
        // Skip jika ada critical warnings
        if (p.warnings > 0)
            return false;
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
function rankPools(pools) {
    return [...pools].sort((a, b) => b.compositeScore - a.compositeScore).slice(0, 5);
}
function getSolAllocationMultiplier(pool) {
    if (pool.organicScore >= 85 && pool.feeActiveTvlRatio > 0.1)
        return 1.5;
    if (pool.tier === 'hot')
        return 1.25;
    return 1.0;
}
function formatPoolsForAI(pools) {
    return pools.map((p, i) => `
Pool ${i + 1}: ${p.name} [${p.tier.toUpperCase()}] — Strategy: ${p.strategy}
  Address: ${p.address}
  Bin Step: ${p.binStep} | Fee Rate: ${p.feeRate}%
  Organic Score: ${p.organicScore}/100 | Holders: ${p.holders.toLocaleString()} | MCap: $${(p.marketCapUsd / 1000).toFixed(0)}K
  Fee/TVL Ratio: ${p.feeActiveTvlRatio.toFixed(4)} | Volume: $${p.volume.toFixed(0)}
  Volatility: ${p.volatility.toFixed(2)} | Price Change: ${p.priceChangePct.toFixed(1)}%
  Warnings: ${p.warnings} | Active Positions: ${p.activePositions}
  Composite Score: ${p.compositeScore}/100 | Max Hold: ${p.maxHoldHours}h
`).join('\n');
}
//# sourceMappingURL=poolFinder.js.map