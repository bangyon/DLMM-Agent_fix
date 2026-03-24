"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkBundlerActivity = checkBundlerActivity;
exports.formatBundlerReportForAI = formatBundlerReportForAI;
const config_1 = require("../config");
async function checkBundlerActivity(connection, poolAddress) {
    const reasons = [];
    let suspicionScore = 0;
    try {
        // Fetch recent swap history dari Meteora API
        const res = await fetch(`${config_1.CONFIG.meteora.apiUrl}/pair/${poolAddress}/analytic/swap_history?limit=100`);
        if (!res.ok) {
            return buildReport(poolAddress, reasons, suspicionScore, 0, 0, 0);
        }
        const data = await res.json();
        const swaps = data.data || [];
        if (swaps.length === 0) {
            return buildReport(poolAddress, reasons, suspicionScore, 0, 0, 0);
        }
        // 1. Cek konsentrasi trader
        const traderVolume = {};
        for (const swap of swaps) {
            const trader = swap.owner || swap.user || 'unknown';
            traderVolume[trader] = (traderVolume[trader] || 0) + Math.abs(parseFloat(swap.inAmount || '0'));
        }
        const traders = Object.entries(traderVolume).sort((a, b) => b[1] - a[1]);
        const totalVolume = traders.reduce((s, [, v]) => s + v, 0);
        const top3Volume = traders.slice(0, 3).reduce((s, [, v]) => s + v, 0);
        const top3Concentration = totalVolume > 0 ? (top3Volume / totalVolume) * 100 : 0;
        if (top3Concentration > 70) {
            suspicionScore += 30;
            reasons.push(`Top 3 trader kuasai ${top3Concentration.toFixed(1)}% volume (>70% mencurigakan)`);
        }
        // 2. Cek large swaps (>5% TVL)
        const tvlRes = await fetch(`${config_1.CONFIG.meteora.apiUrl}/pair/${poolAddress}`);
        const poolData = await tvlRes.json();
        const tvl = parseFloat(poolData.liquidity || '1000000');
        const largeSwapThreshold = tvl * 0.05;
        const largeSwaps = swaps.filter(s => parseFloat(s.inAmount || '0') > largeSwapThreshold);
        if (largeSwaps.length > 5) {
            suspicionScore += 25;
            reasons.push(`${largeSwaps.length} large swap terdeteksi (>5% TVL) dalam 100 transaksi terakhir`);
        }
        // 3. Cek sandwicher pattern — swap in, swap out cepat oleh wallet sama
        const walletSwapTimes = {};
        for (const swap of swaps) {
            const trader = swap.owner || 'unknown';
            if (!walletSwapTimes[trader])
                walletSwapTimes[trader] = [];
            walletSwapTimes[trader].push(parseInt(swap.blockTime || swap.timestamp || '0'));
        }
        let sandwichPatterns = 0;
        for (const [, times] of Object.entries(walletSwapTimes)) {
            if (times.length < 2)
                continue;
            times.sort((a, b) => a - b);
            for (let i = 1; i < times.length; i++) {
                if (times[i] - times[i - 1] < 30)
                    sandwichPatterns++;
            }
        }
        if (sandwichPatterns > 10) {
            suspicionScore += 20;
            reasons.push(`${sandwichPatterns} rapid back-to-back swap dari wallet yang sama (pola sandwich)`);
        }
        // 4. Cek bot pattern — round number amounts
        const roundAmounts = swaps.filter(s => {
            const amount = parseFloat(s.inAmount || '0');
            return amount > 0 && amount % 1000000 === 0;
        });
        if (roundAmounts.length > swaps.length * 0.3) {
            suspicionScore += 15;
            reasons.push(`${roundAmounts.length} swap dengan jumlah bulat (bot pattern)`);
        }
        // 5. Unique traders
        const uniqueTraders = traders.length;
        if (uniqueTraders < 5) {
            suspicionScore += 10;
            reasons.push(`Hanya ${uniqueTraders} unique trader — pool kurang liquid`);
        }
        return buildReport(poolAddress, reasons, Math.min(suspicionScore, 100), largeSwaps.length, uniqueTraders, top3Concentration);
    }
    catch (err) {
        console.error('⚠️  Bundler check gagal (non-fatal):', err);
        return buildReport(poolAddress, ['Gagal fetch data'], 0, 0, 0, 0);
    }
}
function buildReport(poolAddress, reasons, suspicionScore, recentLargeSwaps, uniqueTradersCount, topTraderConcentration) {
    return {
        poolAddress,
        isSuspicious: suspicionScore >= 50,
        suspicionScore,
        reasons,
        recentLargeSwaps,
        uniqueTradersCount,
        topTraderConcentration,
    };
}
function formatBundlerReportForAI(report) {
    return `
Bundler/MEV Analysis untuk pool ${report.poolAddress}:
  Suspicion Score: ${report.suspicionScore}/100 (${report.isSuspicious ? '⚠️ MENCURIGAKAN' : '✅ Normal'})
  Unique Traders: ${report.uniqueTradersCount}
  Top 3 Trader Concentration: ${report.topTraderConcentration.toFixed(1)}%
  Large Swaps (>5% TVL): ${report.recentLargeSwaps}
  ${report.reasons.length > 0 ? 'Temuan:\n  - ' + report.reasons.join('\n  - ') : 'Tidak ada temuan mencurigakan'}
`;
}
//# sourceMappingURL=bundlerChecker.js.map