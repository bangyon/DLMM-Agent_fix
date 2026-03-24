"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
exports.validateConfig = validateConfig;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.CONFIG = {
    wallet: {
        privateKey: process.env.PRIVATE_KEY || '',
    },
    rpc: {
        url: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    },
    ai: {
        provider: (process.env.AI_PROVIDER || 'groq'),
        model: process.env.AI_MODEL || 'llama-3.3-70b-versatile',
        openrouterKey: process.env.OPENROUTER_API_KEY || '',
        groqKey: process.env.GROQ_API_KEY || '',
        anthropicKey: process.env.ANTHROPIC_API_KEY || '',
        lpAgentApiKey: process.env.LP_AGENT_API_KEY || '',
        duneApiKey: process.env.DUNE_API_KEY || '',
    },
    agent: {
        solPerPosition: parseFloat(process.env.SOL_PER_POSITION || '0.1'),
        maxPositions: parseInt(process.env.MAX_POSITIONS || '3'),
        checkIntervalSeconds: parseInt(process.env.CHECK_INTERVAL_SECONDS || '60'),
        minFeeApr: parseFloat(process.env.MIN_FEE_APR || '1'),
        maxLossPercent: parseFloat(process.env.MAX_LOSS_PERCENT || '5'),
        defaultBinRange: parseInt(process.env.DEFAULT_BIN_RANGE || '34'),
    },
    jupiter: {
        apiUrl: process.env.JUPITER_API_URL || 'https://quote-api.jup.ag/v6',
    },
    meteora: {
        apiUrl: process.env.METEORA_API_URL || 'https://dlmm-api.meteora.ag',
    },
};
function validateConfig() {
    if (!exports.CONFIG.wallet.privateKey) {
        throw new Error('❌ PRIVATE_KEY tidak diset di .env');
    }
    const p = exports.CONFIG.ai.provider;
    if (p === 'openrouter' && !exports.CONFIG.ai.openrouterKey)
        throw new Error('❌ OPENROUTER_API_KEY tidak diset');
    if (p === 'groq' && !exports.CONFIG.ai.groqKey)
        throw new Error('❌ GROQ_API_KEY tidak diset');
    if (p === 'anthropic' && !exports.CONFIG.ai.anthropicKey)
        throw new Error('❌ ANTHROPIC_API_KEY tidak diset');
    if (!exports.CONFIG.ai.anthropicKey)
        console.warn('⚠️  ANTHROPIC_API_KEY belum diset — Claude tidak akan digunakan');
    if (!exports.CONFIG.ai.lpAgentApiKey)
        console.warn('⚠️  LP_AGENT_API_KEY belum diset — LP Agent signals nonaktif');
    console.log(`✅ Config valid — AI: ${p} (${exports.CONFIG.ai.model})`);
}
//# sourceMappingURL=index.js.map