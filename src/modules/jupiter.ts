import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { CONFIG } from '../config';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface TokenPrice {
  mint: string;
  symbol: string;
  priceUsd: number;
  change24h: number;
  volume24h: number;
}

export interface VolatilityData {
  symbol: string;
  priceChangePercent: number;
  volatilityScore: number;
  recommendation: 'Spot' | 'Curve' | 'BidAsk';
  suggestedBinRange: number;
}

// Get token price dari Jupiter price API
export async function getTokenPrice(mint: string): Promise<number> {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}&vsToken=${USDC_MINT}`);
    const data = await res.json() as any;
    return data.data?.[mint]?.price || 0;
  } catch {
    return 0;
  }
}

// Get multiple token prices sekaligus
export async function getTokenPrices(mints: string[]): Promise<Record<string, number>> {
  try {
    const ids = mints.join(',');
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${ids}`);
    const data = await res.json() as any;

    const prices: Record<string, number> = {};
    for (const mint of mints) {
      prices[mint] = data.data?.[mint]?.price || 0;
    }
    return prices;
  } catch {
    return {};
  }
}

// Estimasi volatilitas dari Jupiter dan rekomendasikan strategy
export async function analyzeVolatility(
  tokenMint: string,
  tokenSymbol: string,
  binStep: number
): Promise<VolatilityData> {
  // Fetch harga sekarang dan estimasi volatilitas dari pool data
  const currentPrice = await getTokenPrice(tokenMint);

  // Gunakan bin step sebagai proxy volatilitas
  // (pool dengan bin step besar = token volatile)
  let priceChangeEstimate = 0;
  let recommendation: 'Spot' | 'Curve' | 'BidAsk' = 'Spot';
  let suggestedBinRange = 10;
  let volatilityScore = 0;

  if (binStep <= 5) {
    // Stable pairs (USDC/USDT)
    priceChangeEstimate = 0.1;
    recommendation = 'Spot';
    suggestedBinRange = 5;
    volatilityScore = 10;
  } else if (binStep <= 20) {
    // Low-medium volatile (SOL/USDC)
    priceChangeEstimate = 3;
    recommendation = 'Curve';
    suggestedBinRange = 15;
    volatilityScore = 35;
  } else if (binStep <= 80) {
    // Medium volatile
    priceChangeEstimate = 8;
    recommendation = 'Curve';
    suggestedBinRange = 20;
    volatilityScore = 55;
  } else {
    // High volatile (meme coins)
    priceChangeEstimate = 20;
    recommendation = 'BidAsk';
    suggestedBinRange = 30;
    volatilityScore = 80;
  }

  return {
    symbol: tokenSymbol,
    priceChangePercent: priceChangeEstimate,
    volatilityScore,
    recommendation,
    suggestedBinRange,
  };
}

// Swap SOL to token via Jupiter (untuk rebalancing)
export async function swapSolToToken(
  connection: Connection,
  wallet: Keypair,
  outputMint: string,
  solAmountLamports: number,
  slippageBps = 50
): Promise<string | null> {
  try {
    // Get quote
    const quoteRes = await fetch(
      `${CONFIG.jupiter.apiUrl}/quote?inputMint=${SOL_MINT}&outputMint=${outputMint}` +
      `&amount=${solAmountLamports}&slippageBps=${slippageBps}`
    );
    const quote = await quoteRes.json() as any;

    if (quote.error) {
      console.error('Jupiter quote error:', quote.error);
      return null;
    }

    // Get swap transaction
    const swapRes = await fetch(`${CONFIG.jupiter.apiUrl}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
    });

    const swapData = await swapRes.json() as any;
    if (!swapData.swapTransaction) {
      console.error('No swap transaction returned');
      return null;
    }

    // Deserialize dan sign
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);

    const sig = await connection.sendTransaction(transaction, { maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');

    console.log(`   ✅ Swap berhasil! TX: ${sig}`);
    return sig;
  } catch (err) {
    console.error('❌ Swap gagal:', err);
    return null;
  }
}

// Check wallet balances
export async function getWalletBalances(
  connection: Connection,
  walletAddress: string,
  tokenMints: string[]
): Promise<{ sol: number; tokens: Record<string, number> }> {
  try {
    const solBalance = await connection.getBalance(
      require('@solana/web3.js').PublicKey(walletAddress)
    );

    return {
      sol: solBalance / 1e9,
      tokens: {}, // expand if needed
    };
  } catch {
    return { sol: 0, tokens: {} };
  }
}

export function formatVolatilityForAI(data: VolatilityData): string {
  return `
Analisis Volatilitas ${data.symbol}:
  Volatility Score: ${data.volatilityScore}/100
  Estimasi Price Change: ±${data.priceChangePercent}%
  Rekomendasi Strategy: ${data.recommendation}
  Suggested Bin Range: ±${data.suggestedBinRange} bins
`;
}
