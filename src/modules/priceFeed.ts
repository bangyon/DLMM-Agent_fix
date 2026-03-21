export interface TokenMomentum {
  mint: string;
  symbol: string;
  currentPrice: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  volume1h: number;
  volume6h: number;
  volume24h: number;
  feeMomentumScore: number;
  trend: 'up' | 'down' | 'sideways';
  liquidityUsd: number;
  marketCap: number;
}

export interface RugCheckResult {
  isSafe: boolean;
  rugScore: number;
  reasons: string[];
  top10HolderPct: number;
  hasFreezable: boolean;
  hasMintable: boolean;
  liquidityLocked: boolean;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getTokenMomentum(mint: string, symbol: string): Promise<TokenMomentum> {
  const def: TokenMomentum = {
    mint, symbol, currentPrice: 0,
    priceChange1h: 0, priceChange6h: 0, priceChange24h: 0,
    volume1h: 0, volume6h: 0, volume24h: 0,
    feeMomentumScore: 0, trend: 'sideways', liquidityUsd: 0, marketCap: 0,
  };

  try {
    const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs = (data?.pairs || []).filter((p: any) => p.chainId === 'solana');
    if (pairs.length === 0) return def;

    const best = pairs.sort((a: any, b: any) =>
      (b.volume?.h24 || 0) - (a.volume?.h24 || 0)
    )[0];

    const v1h  = Number(best.volume?.h1  || 0);
    const v6h  = Number(best.volume?.h6  || 0);
    const v24h = Number(best.volume?.h24 || 0);

    const avgHourly = v24h / 24;
    const momentumRatio = avgHourly > 0 ? v1h / avgHourly : 0;
    const feeMomentumScore = Math.min(100, Math.round(momentumRatio * 33));

    const pc1h  = Number(best.priceChange?.h1  || 0);
    const pc6h  = Number(best.priceChange?.h6  || 0);
    const pc24h = Number(best.priceChange?.h24 || 0);

    return {
      mint, symbol,
      currentPrice:    Number(best.priceUsd || 0),
      priceChange1h:   pc1h,
      priceChange6h:   pc6h,
      priceChange24h:  pc24h,
      volume1h:        v1h,
      volume6h:        v6h,
      volume24h:       v24h,
      feeMomentumScore,
      trend: pc1h > 2 ? 'up' : pc1h < -2 ? 'down' : 'sideways',
      liquidityUsd:    Number(best.liquidity?.usd || 0),
      marketCap:       Number(best.marketCap || 0),
    };
  } catch {
    return def;
  }
}

export async function getMultipleTokenMomentum(
  tokens: Array<{ mint: string; symbol: string }>
): Promise<Map<string, TokenMomentum>> {
  const results = new Map<string, TokenMomentum>();
  await Promise.all(tokens.slice(0, 5).map(async t => {
    results.set(t.mint, await getTokenMomentum(t.mint, t.symbol));
  }));
  return results;
}

export async function checkRug(mint: string): Promise<RugCheckResult> {
  const safe: RugCheckResult = {
    isSafe: true, rugScore: 0, reasons: [],
    top10HolderPct: 0, hasFreezable: false,
    hasMintable: false, liquidityLocked: false,
  };
  try {
    const data = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    const risks: any[] = data?.risks || [];
    const hasFreezable = risks.some((r: any) => r.name?.toLowerCase().includes('freeze'));
    const hasMintable  = risks.some((r: any) => r.name?.toLowerCase().includes('mint'));
    const rugScore = Math.min(100, Math.round(Number(data?.score || 0) / 10));
    return {
      isSafe: rugScore < 50 && !hasFreezable,
      rugScore,
      reasons: risks.filter((r: any) => r.level === 'danger' || r.level === 'warn').map((r: any) => r.name),
      top10HolderPct: Number(data?.topHolders?.top10Pct || 0),
      hasFreezable,
      hasMintable,
      liquidityLocked: data?.markets?.[0]?.lp?.lpLockedPct > 50,
    };
  } catch {
    return safe;
  }
}

export function formatMomentumForAI(m: TokenMomentum, rug: RugCheckResult): string {
  return `
Token: ${m.symbol}
  Price: $${m.currentPrice.toFixed(8)} | Trend: ${m.trend}
  Price change: 1h ${m.priceChange1h > 0 ? '+' : ''}${m.priceChange1h.toFixed(1)}% | 6h ${m.priceChange6h > 0 ? '+' : ''}${m.priceChange6h.toFixed(1)}% | 24h ${m.priceChange24h > 0 ? '+' : ''}${m.priceChange24h.toFixed(1)}%
  Volume: 1h $${m.volume1h.toLocaleString()} | 24h $${m.volume24h.toLocaleString()}
  Fee Momentum: ${m.feeMomentumScore}/100 ${m.feeMomentumScore > 60 ? '(NAIK - SIGNAL KUAT)' : m.feeMomentumScore > 30 ? '(stabil)' : '(lesu)'}
  Liquidity: $${m.liquidityUsd.toLocaleString()} | Market Cap: $${m.marketCap.toLocaleString()}
  Rug Score: ${rug.rugScore}/100 ${rug.isSafe ? '(AMAN)' : '(BERISIKO)'}${rug.hasFreezable ? ' ⚠️ FREEZABLE!' : ''}${rug.hasMintable ? ' ⚠️ MINTABLE!' : ''}
`;
}
