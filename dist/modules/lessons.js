"use strict";
// Learning system — inspired by Meridian's lessons.js
// Bot belajar dari setiap posisi yang ditutup dan evolve threshold-nya
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordPerformance = recordPerformance;
exports.getLessonsForPrompt = getLessonsForPrompt;
exports.getPerformanceSummary = getPerformanceSummary;
const fs = __importStar(require("fs"));
const LESSONS_FILE = 'data/lessons.json';
const MIN_EVOLVE_POSITIONS = 5;
function load() {
    try {
        if (!fs.existsSync(LESSONS_FILE))
            return { lessons: [], performance: [] };
        return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8'));
    }
    catch {
        return { lessons: [], performance: [] };
    }
}
function save(data) {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}
// Record performance saat posisi close
async function recordPerformance(perf) {
    const data = load();
    const pnlSol = (perf.finalValueSol + perf.feesEarnedSol) - perf.initialValueSol;
    const pnlPct = perf.initialValueSol > 0 ? (pnlSol / perf.initialValueSol) * 100 : 0;
    const rangeEfficiency = perf.minutesHeld > 0
        ? (perf.minutesInRange / perf.minutesHeld) * 100 : 0;
    const entry = {
        ...perf, pnlSol, pnlPct, rangeEfficiency,
        recordedAt: new Date().toISOString(),
    };
    data.performance.push(entry);
    // Generate lesson
    const lesson = deriveLesson(entry);
    if (lesson) {
        data.lessons.push(lesson);
        console.log(`📚 New lesson: ${lesson.rule.slice(0, 80)}`);
    }
    // Auto-evolve setiap 5 posisi
    if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
        evolveThresholds(data.performance);
        console.log(`🧠 Thresholds auto-evolved (${data.performance.length} positions)`);
    }
    save(data);
}
function deriveLesson(perf) {
    const outcome = perf.pnlPct >= 5 ? 'good'
        : perf.pnlPct >= -5 ? 'neutral' : 'bad';
    if (outcome === 'neutral')
        return null;
    const ctx = `${perf.poolName} organic=${perf.organicScore} holders=${perf.holders} fee/tvl=${perf.feeActiveTvlRatio?.toFixed(3)} strategy=${perf.strategy}`;
    let rule = '';
    const tags = [];
    if (outcome === 'bad' && perf.rangeEfficiency < 30) {
        rule = `AVOID: ${perf.poolName}-type (organic=${perf.organicScore}, bin_step=${perf.binStep}) strategy="${perf.strategy}" — out of range ${(100 - perf.rangeEfficiency).toFixed(0)}% of time. PnL ${perf.pnlPct.toFixed(1)}%.`;
        tags.push('oor', perf.strategy);
    }
    else if (outcome === 'good' && perf.rangeEfficiency > 70) {
        rule = `PREFER: ${ctx} — ${perf.rangeEfficiency.toFixed(0)}% in-range, PnL +${perf.pnlPct.toFixed(1)}%. Fees ${perf.feesEarnedSol.toFixed(4)} SOL.`;
        tags.push('efficient', perf.strategy);
    }
    else if (outcome === 'bad' && perf.closeReason?.includes('volume')) {
        rule = `AVOID: fee/tvl=${perf.feeActiveTvlRatio?.toFixed(3)} with volume collapse — fees evaporated. Check volume trend before entry.`;
        tags.push('volume_collapse');
    }
    else if (outcome === 'good') {
        rule = `WORKED: ${ctx} → PnL +${perf.pnlPct.toFixed(1)}%, range ${perf.rangeEfficiency.toFixed(0)}%.`;
        tags.push('worked');
    }
    else {
        rule = `FAILED: ${ctx} → PnL ${perf.pnlPct.toFixed(1)}%, range ${perf.rangeEfficiency.toFixed(0)}%. Reason: ${perf.closeReason}.`;
        tags.push('failed');
    }
    if (!rule)
        return null;
    return {
        id: Date.now(),
        rule, tags, outcome,
        pnlPct: perf.pnlPct,
        rangeEfficiency: perf.rangeEfficiency,
        poolName: perf.poolName,
        createdAt: new Date().toISOString(),
    };
}
// Auto-adjust threshold berdasarkan performance
function evolveThresholds(perfData) {
    if (perfData.length < MIN_EVOLVE_POSITIONS)
        return;
    const winners = perfData.filter(p => p.pnlPct > 0);
    const losers = perfData.filter(p => p.pnlPct < -5);
    if (winners.length < 2 && losers.length < 2)
        return;
    const configPath = 'data/evolved-thresholds.json';
    let thresholds = {};
    try {
        if (fs.existsSync(configPath))
            thresholds = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    catch { }
    const changes = {};
    // Adjust minOrganic berdasarkan winner vs loser
    if (winners.length >= 2 && losers.length >= 2) {
        const avgWinOrg = winners.reduce((s, p) => s + (p.organicScore || 0), 0) / winners.length;
        const avgLoseOrg = losers.reduce((s, p) => s + (p.organicScore || 0), 0) / losers.length;
        if (avgWinOrg - avgLoseOrg >= 10) {
            const newMin = Math.max(65, Math.min(85, Math.round(avgLoseOrg + 5)));
            if (newMin !== thresholds.minOrganic) {
                changes.minOrganic = newMin;
            }
        }
    }
    // Adjust minFeeActiveTvlRatio
    if (winners.length >= 3) {
        const minWinFee = Math.min(...winners.map(p => p.feeActiveTvlRatio || 0).filter((f) => f > 0));
        if (minWinFee > 0 && minWinFee > (thresholds.minFeeActiveTvlRatio || 0.02) * 1.2) {
            changes.minFeeActiveTvlRatio = parseFloat((minWinFee * 0.8).toFixed(4));
        }
    }
    if (Object.keys(changes).length > 0) {
        Object.assign(thresholds, changes, {
            lastEvolved: new Date().toISOString(),
            positionsAtEvolution: perfData.length,
        });
        fs.writeFileSync(configPath, JSON.stringify(thresholds, null, 2));
        console.log(`🧬 Evolved thresholds:`, changes);
    }
}
// Get lessons untuk inject ke AI prompt
function getLessonsForPrompt(maxLessons = 10) {
    const data = load();
    if (data.lessons.length === 0)
        return '';
    const selected = data.lessons
        .sort((a, b) => {
        const priority = { bad: 0, good: 1, manual: 2, neutral: 3 };
        return (priority[a.outcome] ?? 3) - (priority[b.outcome] ?? 3);
    })
        .slice(-maxLessons);
    return selected.map(l => {
        const date = l.createdAt.slice(0, 10);
        return `[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
    }).join('\n');
}
function getPerformanceSummary() {
    const data = load();
    if (data.performance.length === 0)
        return 'Belum ada posisi yang ditutup';
    const wins = data.performance.filter((p) => p.pnlPct > 0).length;
    const totalPnl = data.performance.reduce((s, p) => s + (p.pnlSol || 0), 0);
    const avgPnl = data.performance.reduce((s, p) => s + (p.pnlPct || 0), 0) / data.performance.length;
    return `${data.performance.length} posisi closed | Win rate: ${Math.round(wins / data.performance.length * 100)}% | Total PnL: ${totalPnl.toFixed(4)} SOL | Avg PnL: ${avgPnl.toFixed(1)}%`;
}
//# sourceMappingURL=lessons.js.map