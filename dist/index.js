"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const orchestrator_1 = require("./agent/orchestrator");
const feeTracker_1 = require("./utils/feeTracker");
const poolFinder_1 = require("./modules/poolFinder");
const simulator_1 = require("./backtest/simulator");
const args = process.argv.slice(2);
async function main() {
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║     DLMM Agent — Meteora LP Manager    ║');
    console.log('╚════════════════════════════════════════╝\n');
    // --report: tidak perlu wallet
    if (args.includes('--report')) {
        (0, feeTracker_1.printFeeReport)();
        return;
    }
    // --backtest: tidak perlu wallet, langsung fetch pools & simulate
    if (args.includes('--backtest')) {
        const idx = args.indexOf('--backtest');
        const days = parseInt(args[idx + 1] || '7');
        console.log(`🧪 MODE BACKTEST — ${days} hari, tidak ada transaksi nyata\n`);
        try {
            const modeArg = args.includes('--conservative') ? 'conservative' : 'aggressive';
            console.log(`   Mode: ${modeArg} (gunakan --conservative untuk hanya major pairs)`);
            const pools = await (0, poolFinder_1.getTopPools)(10);
            if (pools.length === 0) {
                console.log('⚠️  Tidak ada pool yang ditemukan. Cek RPC_URL di .env');
                return;
            }
            const top = (0, poolFinder_1.rankPools)(pools).slice(0, 3).map(p => ({
                address: p.address,
                name: p.name,
                binStep: p.binStep,
            }));
            await (0, simulator_1.comparePoolBacktests)(top, days);
        }
        catch (err) {
            console.error('❌ Backtest error:', err);
        }
        return;
    }
    // Live mode: butuh wallet & full config
    try {
        (0, config_1.validateConfig)();
        const agent = new orchestrator_1.DLMMAgent();
        process.on('SIGINT', () => { agent.stop(); setTimeout(() => process.exit(0), 1000); });
        process.on('SIGTERM', () => { agent.stop(); setTimeout(() => process.exit(0), 1000); });
        await agent.start();
    }
    catch (err) {
        console.error('\n❌ Fatal error:', err);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=index.js.map