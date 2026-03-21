// LP Agent API Integration
// Docs: https://lpagent.mintlify.app/api-reference
// API: https://api.lpagent.io/open-api/v1/

const LP_AGENT_API = 'https://api.lpagent.io/open-api/v1';

export interface LPAgentPosition {
  owner: string;
  pool: string;
  pairName: string;
  strategyType: string;
  inRange: boolean;
  currentValue: number;
  inputValue: number;
  collectedFeeNative: number;
  pnlPercent: number;
  pnlNative: number;
  dprNative: number;    // daily profit rate in SOL
  age: string;          // jam
  tickLower: number;
  tickUpper: number;
  token0: string;
  token1: string;
}

export interface SmartLPTrader {
  wallet: string;
  label: string;
  totalPnlSol: number;
  winRate: number;
  openPositions: LPAgentPosition[];
  preferredPools: string[];   // pool addresses yang sering dipakai
  avgBinRange: number;
  preferredStrategy: string;
}

export interface LPAgentSignal {
  pool: string;
  pairName: string;
  traderCount: number;
  traders: SmartLPTrader[];
  consensusScore: number;
  avgStrategyType: string;
  avgTickRange: number;
  signal: 'strong_entry' | 'entry' | 'neutral' | 'avoid';
  totalValueInPool: number;  // total USD yang di-LP top traders di pool ini
}

async function fetchJson(url: string, apiKey: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`LP Agent API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Fetch posisi aktif wallet tertentu via LP Agent API
export async function getLPAgentPositions(
  walletAddress: string,
  apiKey: string
): Promise<LPAgentPosition[]> {
  try {
    const data = await fetchJson(
      `${LP_AGENT_API}/lp-positions/opening?owner=${walletAddress}`,
      apiKey
    );

    if (data.status !== 'success' || !data.data) return [];

    return data.data
      .filter((p: any) => p.protocol === 'meteora')
      .map((p: any) => ({
        owner: walletAddress,
        pool: p.pool || '',
        pairName: p.pairName || p.tokenName0 + '-' + p.tokenName1 || '',
        strategyType: p.strategyType || 'BidAsk',
        inRange: p.inRange || false,
        currentValue: parseFloat(p.currentValue || '0'),
        inputValue: parseFloat(p.inputValue || '0'),
        collectedFeeNative: p.collectedFeeNative || 0,
        pnlPercent: p.pnl?.percent || 0,
        pnlNative: p.pnlNative || 0,
        dprNative: p.dprNative || 0,
        age: p.age || '0',
        tickLower: p.tickLower || p.range?.[0] || 0,
        tickUpper: p.tickUpper || p.range?.[1] || 0,
        token0: p.token0 || '',
        token1: p.token1 || '',
      }));
  } catch (err) {
    console.log(`   ⚠️  LP Agent fetch gagal untuk ${walletAddress.slice(0, 8)}: ${err}`);
    return [];
  }
}

// Fetch historical performance wallet via LP Agent API
export async function getLPAgentHistory(
  walletAddress: string,
  apiKey: string,
  limit = 20
): Promise<any[]> {
  try {
    const data = await fetchJson(
      `${LP_AGENT_API}/lp-positions/historical?owner=${walletAddress}&limit=${limit}&protocol=meteora`,
      apiKey
    );
    return data.data || [];
  } catch {
    return [];
  }
}

// Main: fetch signals dari multiple top trader wallets via LP Agent
export async function getLPAgentSignals(
  topWallets: string[],
  apiKey: string
): Promise<LPAgentSignal[]> {
  if (!apiKey) {
    console.log('   ⚠️  LP_AGENT_API_KEY tidak diset — skip LP Agent signals');
    return [];
  }

  console.log(`   🔗 LP Agent: checking ${topWallets.length} top trader wallets...`);

  // Fetch semua posisi secara parallel
  const allResults = await Promise.allSettled(
    topWallets.map(async wallet => ({
      wallet,
      positions: await getLPAgentPositions(wallet, apiKey),
    }))
  );

  // Aggregate: pool mana yang dimasuki multiple top traders
  const poolMap = new Map<string, {
    positions: LPAgentPosition[];
    traders: string[];
    totalValue: number;
  }>();

  for (const result of allResults) {
    if (result.status !== 'fulfilled') continue;
    const { wallet, positions } = result.value;

    for (const pos of positions) {
      if (!pos.pool) continue;
      if (!poolMap.has(pos.pool)) {
        poolMap.set(pos.pool, { positions: [], traders: [], totalValue: 0 });
      }
      const entry = poolMap.get(pos.pool)!;
      entry.positions.push(pos);
      entry.traders.push(wallet);
      entry.totalValue += pos.currentValue;
    }
  }

  // Build signals
  const signals: LPAgentSignal[] = [];

  for (const [pool, data] of poolMap.entries()) {
    if (data.traders.length === 0) continue;

    // Hitung rata-rata tick range → bin range equivalent
    const avgTickRange = data.positions.reduce((s, p) =>
      s + Math.abs(p.tickUpper - p.tickLower), 0) / data.positions.length;

    // Strategy paling populer
    const strategies = data.positions.map(p => p.strategyType);
    const strategyCount = strategies.reduce((acc, s) => {
      acc[s] = (acc[s] || 0) + 1; return acc;
    }, {} as Record<string, number>);
    const topStrategy = Object.entries(strategyCount)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || 'BidAsk';

    const consensusScore = Math.min(100, data.traders.length * 30);
    const pairName = data.positions[0]?.pairName || pool.slice(0, 8);

    signals.push({
      pool,
      pairName,
      traderCount: data.traders.length,
      traders: [],
      consensusScore,
      avgStrategyType: topStrategy,
      avgTickRange,
      signal: data.traders.length >= 3 ? 'strong_entry'
             : data.traders.length >= 2 ? 'entry'
             : 'neutral',
      totalValueInPool: data.totalValue,
    });
  }

  // Sort by consensus
  signals.sort((a, b) => b.consensusScore - a.consensusScore);

  if (signals.length > 0) {
    console.log(`   ✅ LP Agent: ${signals.length} pool dengan top trader aktif`);
    for (const s of signals.slice(0, 5)) {
      console.log(`      ${s.signal === 'strong_entry' ? '🔥' : '✅'} ${s.pairName} — ${s.traderCount} traders | $${s.totalValueInPool.toLocaleString()} | ${s.avgStrategyType}`);
    }
  } else {
    console.log('   📭 LP Agent: tidak ada pool dengan multiple top traders');
  }

  return signals;
}

export function formatLPAgentSignalForAI(signals: LPAgentSignal[]): string {
  if (signals.length === 0) {
    return 'LP Agent: Tidak ada signal dari top traders saat ini.';
  }

  return `
=== LP AGENT TOP TRADER SIGNALS ===
${signals.slice(0, 5).map((s, i) => `
${i + 1}. ${s.pairName} [${s.signal.toUpperCase().replace('_', ' ')}]
   Pool: ${s.pool}
   Top traders aktif: ${s.traderCount} | Consensus: ${s.consensusScore}/100
   Total value di pool: $${s.totalValueInPool.toLocaleString()}
   Strategy yang dipakai: ${s.avgStrategyType}
   Avg tick range: ±${Math.round(s.avgTickRange / 2)} bins
   ${s.signal === 'strong_entry' ? '⚡ MULTIPLE TOP TRADERS MASUK — SIGNAL KUAT!' : ''}
`).join('')}
Gunakan signal ini sebagai KONFIRMASI tambahan, bukan satu-satunya alasan entry.
`;
}
