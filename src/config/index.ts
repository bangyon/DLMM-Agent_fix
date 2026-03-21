import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  wallet: {
    privateKey: process.env.PRIVATE_KEY || '',
  },
  rpc: {
    url: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  },
  ai: {
    provider: (process.env.AI_PROVIDER || 'groq') as 'openrouter' | 'groq' | 'anthropic',
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

export function validateConfig() {
  if (!CONFIG.wallet.privateKey) {
    throw new Error('❌ PRIVATE_KEY tidak diset di .env');
  }
  const p = CONFIG.ai.provider;
  if (p === 'openrouter' && !CONFIG.ai.openrouterKey) throw new Error('❌ OPENROUTER_API_KEY tidak diset');
  if (p === 'groq' && !CONFIG.ai.groqKey) throw new Error('❌ GROQ_API_KEY tidak diset');
  if (p === 'anthropic' && !CONFIG.ai.anthropicKey) throw new Error('❌ ANTHROPIC_API_KEY tidak diset');
  if (!CONFIG.ai.anthropicKey) console.warn('⚠️  ANTHROPIC_API_KEY belum diset — Claude tidak akan digunakan');
  if (!CONFIG.ai.lpAgentApiKey) console.warn('⚠️  LP_AGENT_API_KEY belum diset — LP Agent signals nonaktif');
  console.log(`✅ Config valid — AI: ${p} (${CONFIG.ai.model})`);
}
