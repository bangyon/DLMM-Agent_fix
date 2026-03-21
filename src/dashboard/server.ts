import http from 'http';
import fs from 'fs';
import path from 'path';
import { getCompoundStats } from '../utils/feeTracker';

export interface DashboardState {
  wallet: string;
  solBalance: number;
  activePositions: any[];
  cycleCount: number;
  lastCycleAt: string;
  isRunning: boolean;
  feeStats: any;
}

let currentState: DashboardState = {
  wallet: '',
  solBalance: 0,
  activePositions: [],
  cycleCount: 0,
  lastCycleAt: '',
  isRunning: false,
  feeStats: {},
};

export function updateDashboardState(partial: Partial<DashboardState>) {
  currentState = { ...currentState, ...partial };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DLMM Agent Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; color: #e2e8f0; font-family: 'Segoe UI', sans-serif; padding: 24px; }
  h1 { font-size: 20px; font-weight: 600; color: #a78bfa; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #1a1d2e; border: 1px solid #2d3150; border-radius: 12px; padding: 16px; }
  .card-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .card-value { font-size: 24px; font-weight: 700; }
  .card-value.green { color: #34d399; }
  .card-value.purple { color: #a78bfa; }
  .card-value.blue { color: #60a5fa; }
  .card-value.amber { color: #fbbf24; }
  .section-title { font-size: 13px; font-weight: 600; color: #94a3b8; margin-bottom: 12px; margin-top: 24px; text-transform: uppercase; }
  .position-card { background: #1a1d2e; border: 1px solid #2d3150; border-radius: 10px; padding: 14px; margin-bottom: 10px; }
  .position-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .position-name { font-weight: 600; font-size: 14px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 500; }
  .badge.in-range { background: #064e3b; color: #34d399; }
  .badge.out-range { background: #450a0a; color: #f87171; }
  .position-stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; font-size: 12px; }
  .stat-label { color: #64748b; }
  .stat-val { color: #e2e8f0; font-weight: 500; }
  .pnl-pos { color: #34d399; }
  .pnl-neg { color: #f87171; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .status-dot.running { background: #34d399; animation: pulse 2s infinite; }
  .status-dot.stopped { background: #f87171; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .wallet { font-family: monospace; font-size: 12px; color: #64748b; margin-bottom: 20px; }
  .empty { text-align: center; color: #475569; padding: 32px; font-size: 13px; }
  .fee-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .fee-table th { text-align: left; color: #64748b; padding: 6px 8px; border-bottom: 1px solid #2d3150; }
  .fee-table td { padding: 6px 8px; border-bottom: 1px solid #1e2235; }
  .refresh-time { font-size: 11px; color: #475569; margin-top: 16px; }
</style>
</head>
<body>
<h1>🤖 DLMM Agent Dashboard</h1>
<div id="app"><p class="empty">Loading...</p></div>

<script>
async function load() {
  try {
    const res = await fetch('/api/state');
    const d = await res.json();

    const pnlClass = (v) => v >= 0 ? 'pnl-pos' : 'pnl-neg';
    const fmtPnl = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';

    const positions = d.activePositions.length > 0
      ? d.activePositions.map(p => \`
        <div class="position-card">
          <div class="position-header">
            <span class="position-name">\${p.poolName}</span>
            <span class="badge \${p.isInRange ? 'in-range' : 'out-range'}">\${p.isInRange ? '✓ In Range' : '✗ Out of Range'}</span>
          </div>
          <div class="position-stats">
            <div><span class="stat-label">Strategy</span><br><span class="stat-val">\${p.strategyType}</span></div>
            <div><span class="stat-label">PnL</span><br><span class="stat-val \${pnlClass(p.pnlPercent)}">\${fmtPnl(p.pnlPercent)}</span></div>
            <div><span class="stat-label">Fee Earned</span><br><span class="stat-val green">\${p.feeEarned.toFixed(4)} SOL</span></div>
            <div><span class="stat-label">SOL deposit</span><br><span class="stat-val">\${p.solDeposited} SOL</span></div>
            <div><span class="stat-label">Bin Range</span><br><span class="stat-val">±\${p.binRange}</span></div>
            <div><span class="stat-label">Dibuka</span><br><span class="stat-val">\${new Date(p.openedAt).toLocaleTimeString('id-ID')}</span></div>
          </div>
        </div>
      \`).join('')
      : '<div class="empty">Tidak ada posisi aktif</div>';

    const feeRows = Object.entries(d.feeStats.positions || {}).map(([addr, data]) =>
      \`<tr><td style="font-family:monospace">\${addr.slice(0,12)}...</td><td class="green">\${data.totalFee.toFixed(6)} SOL</td><td>\${data.claimCount}x</td></tr>\`
    ).join('') || '<tr><td colspan="3" style="color:#475569;text-align:center;padding:12px">Belum ada fee diklaim</td></tr>';

    document.getElementById('app').innerHTML = \`
      <div class="wallet">👛 \${d.wallet}</div>
      <div class="grid">
        <div class="card">
          <div class="card-label">Saldo SOL</div>
          <div class="card-value green">\${d.solBalance.toFixed(4)}</div>
        </div>
        <div class="card">
          <div class="card-label">Status</div>
          <div class="card-value" style="font-size:16px">
            <span class="status-dot \${d.isRunning ? 'running' : 'stopped'}"></span>
            \${d.isRunning ? 'Running' : 'Stopped'}
          </div>
        </div>
        <div class="card">
          <div class="card-label">Posisi Aktif</div>
          <div class="card-value purple">\${d.activePositions.length}</div>
        </div>
        <div class="card">
          <div class="card-label">Total Cycle</div>
          <div class="card-value blue">\${d.cycleCount}</div>
        </div>
        <div class="card">
          <div class="card-label">Total Fee Claimed</div>
          <div class="card-value amber">\${(d.feeStats.totalFeeClaimed || 0).toFixed(4)} SOL</div>
        </div>
        <div class="card">
          <div class="card-label">Last Cycle</div>
          <div class="card-value" style="font-size:14px">\${d.lastCycleAt || '-'}</div>
        </div>
      </div>

      <div class="section-title">Posisi Aktif</div>
      \${positions}

      <div class="section-title">Fee History per Pool</div>
      <div class="card">
        <table class="fee-table">
          <thead><tr><th>Pool</th><th>Total Fee</th><th>Claims</th></tr></thead>
          <tbody>\${feeRows}</tbody>
        </table>
      </div>

      <div class="refresh-time">Auto refresh setiap 15 detik · Last: \${new Date().toLocaleTimeString('id-ID')}</div>
    \`;
  } catch(e) {
    document.getElementById('app').innerHTML = '<p class="empty">Gagal load data: ' + e.message + '</p>';
  }
}

load();
setInterval(load, 15000);
</script>
</body>
</html>`;

export function startDashboard(port = 3000) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/state') {
      const state = {
        ...currentState,
        feeStats: getCompoundStats(),
      };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(state));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
    }
  });

  server.listen(port, () => {
    console.log(`\n🌐 Dashboard: http://localhost:${port}`);
  });

  return server;
}
