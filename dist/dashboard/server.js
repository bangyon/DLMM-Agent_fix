"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateDashboardState = updateDashboardState;
exports.startDashboard = startDashboard;
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const feeTracker_1 = require("../utils/feeTracker");
let currentState = {
    wallet: '', solBalance: 0, activePositions: [],
    cycleCount: 0, lastCycleAt: '', isRunning: false, feeStats: {},
};
const clients = new Set();
function updateDashboardState(partial) {
    currentState = { ...currentState, ...partial, feeStats: (0, feeTracker_1.getCompoundStats)() };
    // Broadcast ke semua WebSocket clients
    const payload = JSON.stringify(currentState);
    for (const client of clients) {
        if (client.readyState === ws_1.WebSocket.OPEN) {
            client.send(payload);
        }
    }
}
const HTML = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DLMM Agent</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #050508;
  --bg2: #0c0c14;
  --bg3: #12121e;
  --border: #1e1e30;
  --border2: #2a2a42;
  --text: #e8e8f0;
  --muted: #4a4a6a;
  --green: #00ff88;
  --red: #ff4466;
  --blue: #4488ff;
  --purple: #aa88ff;
  --amber: #ffaa00;
  --cyan: #00ddff;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Space Grotesk', sans-serif;
  min-height: 100vh;
  padding: 0;
}
/* Header */
.header {
  background: linear-gradient(135deg, #0a0a18 0%, #0f0f20 100%);
  border-bottom: 1px solid var(--border);
  padding: 16px 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(10px);
}
.logo {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 700;
  color: var(--purple);
  letter-spacing: 0.1em;
}
.status-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 100px;
  border: 1px solid;
}
.status-badge.running {
  color: var(--green);
  border-color: rgba(0,255,136,0.3);
  background: rgba(0,255,136,0.05);
}
.status-badge.stopped {
  color: var(--red);
  border-color: rgba(255,68,102,0.3);
  background: rgba(255,68,102,0.05);
}
.dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.dot.pulse { animation: pulse 2s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.8)} }

/* Layout */
.container { padding: 24px 32px; max-width: 1400px; margin: 0 auto; }

/* Stats Grid */
.stats {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}
@media(max-width:1200px){ .stats { grid-template-columns: repeat(3,1fr); } }
@media(max-width:600px){ .stats { grid-template-columns: repeat(2,1fr); } }

.stat-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  position: relative;
  overflow: hidden;
  transition: border-color 0.2s;
}
.stat-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: var(--accent, var(--border));
  opacity: 0.6;
}
.stat-card:hover { border-color: var(--border2); }
.stat-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 8px;
}
.stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
}

/* Sections */
.section { margin-bottom: 24px; }
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.badge-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 100px;
  background: var(--bg3);
  border: 1px solid var(--border);
  color: var(--muted);
}

/* Position Cards */
.pos-card {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 10px;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 16px;
  align-items: center;
  transition: border-color 0.2s, transform 0.1s;
}
.pos-card:hover { border-color: var(--border2); transform: translateY(-1px); }
.pos-indicator {
  width: 4px;
  border-radius: 4px;
  height: 100%;
  min-height: 60px;
  background: var(--range-color, var(--border));
}
.pos-name { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
.pos-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.pos-tag {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--bg3);
  border: 1px solid var(--border);
  color: var(--muted);
}
.pos-stats {
  display: grid;
  grid-template-columns: repeat(3, auto);
  gap: 16px;
  text-align: right;
}
.ps-label { font-size: 10px; color: var(--muted); margin-bottom: 2px; }
.ps-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 600;
}
.range-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 100px;
  letter-spacing: 0.05em;
}
.in-range { background: rgba(0,255,136,0.1); color: var(--green); border: 1px solid rgba(0,255,136,0.2); }
.out-range { background: rgba(255,68,102,0.1); color: var(--red); border: 1px solid rgba(255,68,102,0.2); }

/* Pool scan table */
.pool-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.pool-table th {
  text-align: left;
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.pool-table td { padding: 10px 12px; border-bottom: 1px solid var(--bg3); }
.pool-table tr:hover td { background: var(--bg3); }
.pool-table .mono { font-family: 'JetBrains Mono', monospace; }
.score-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.score-fill {
  height: 4px;
  border-radius: 2px;
  background: var(--purple);
  min-width: 4px;
}

/* Empty state */
.empty {
  text-align: center;
  color: var(--muted);
  padding: 40px;
  font-size: 13px;
}

/* Wallet */
.wallet-bar {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--muted);
  margin-bottom: 20px;
  padding: 8px 12px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ws-indicator {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--red);
  transition: background 0.3s;
}
.ws-indicator.connected { background: var(--green); animation: pulse 3s ease-in-out infinite; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">⬡ DLMM AGENT</div>
  <div id="status-badge" class="status-badge stopped">
    <span class="dot"></span>
    <span>Stopped</span>
  </div>
</div>

<div class="container">
  <div class="wallet-bar">
    <div class="ws-indicator" id="ws-dot"></div>
    <span id="wallet-addr">Connecting...</span>
  </div>

  <!-- Stats -->
  <div class="stats" id="stats-grid">
    <div class="stat-card" style="--accent:var(--green)">
      <div class="stat-label">SOL Balance</div>
      <div class="stat-value" style="color:var(--green)" id="s-sol">—</div>
    </div>
    <div class="stat-card" style="--accent:var(--purple)">
      <div class="stat-label">Active Positions</div>
      <div class="stat-value" style="color:var(--purple)" id="s-pos">—</div>
    </div>
    <div class="stat-card" style="--accent:var(--amber)">
      <div class="stat-label">Fee Claimed</div>
      <div class="stat-value" style="color:var(--amber)" id="s-fee">—</div>
    </div>
    <div class="stat-card" style="--accent:var(--blue)">
      <div class="stat-label">Cycles</div>
      <div class="stat-value" style="color:var(--blue)" id="s-cycle">—</div>
    </div>
    <div class="stat-card" style="--accent:var(--cyan)">
      <div class="stat-label">Total PnL</div>
      <div class="stat-value" id="s-pnl">—</div>
    </div>
    <div class="stat-card" style="--accent:var(--muted)">
      <div class="stat-label">Last Cycle</div>
      <div class="stat-value" style="font-size:11px;color:var(--muted)" id="s-last">—</div>
    </div>
  </div>

  <!-- Active Positions -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Active Positions</div>
      <div class="badge-count" id="pos-count">0</div>
    </div>
    <div id="positions-list"><div class="empty">No active positions</div></div>
  </div>

  <!-- Pool Scan -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Latest Pool Scan</div>
      <div class="badge-count" id="pool-count">0 pools</div>
    </div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden">
      <table class="pool-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Pool</th>
            <th>Organic</th>
            <th>Holders</th>
            <th>MCap</th>
            <th>Fee/TVL</th>
            <th>Volume</th>
            <th>Strategy</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody id="pool-table-body">
          <tr><td colspan="9" class="empty">Waiting for scan...</td></tr>
        </tbody>
      </table>
    </div>
    <div style="font-size:10px;color:var(--muted);margin-top:8px" id="scan-time"></div>
  </div>

  <!-- Fee History -->
  <div class="section">
    <div class="section-header">
      <div class="section-title">Fee History</div>
    </div>
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden">
      <table class="pool-table">
        <thead><tr><th>Pool</th><th>Fee Earned</th><th>Claims</th></tr></thead>
        <tbody id="fee-table-body">
          <tr><td colspan="3" class="empty">No fee claims yet</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<script>
let ws;
let reconnectTimer;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');

  ws.onopen = () => {
    document.getElementById('ws-dot').classList.add('connected');
  };

  ws.onclose = () => {
    document.getElementById('ws-dot').classList.remove('connected');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onmessage = (e) => {
    try { render(JSON.parse(e.data)); } catch {}
  };
}

function fmt(n, d=4) { return Number(n||0).toFixed(d); }
function fmtK(n) {
  if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
  return '$' + Number(n||0).toFixed(0);
}

function render(d) {
  // Status badge
  const badge = document.getElementById('status-badge');
  badge.className = 'status-badge ' + (d.isRunning ? 'running' : 'stopped');
  badge.innerHTML = '<span class="dot' + (d.isRunning ? ' pulse' : '') + '"></span><span>' + (d.isRunning ? 'Running' : 'Stopped') + '</span>';

  // Wallet
  document.getElementById('wallet-addr').textContent = d.wallet
    ? d.wallet.slice(0,8) + '...' + d.wallet.slice(-8) + ' (' + d.wallet + ')'
    : 'No wallet';

  // Stats
  document.getElementById('s-sol').textContent = fmt(d.solBalance, 4) + ' SOL';
  document.getElementById('s-pos').textContent = d.activePositions.length;
  document.getElementById('s-fee').textContent = fmt(d.feeStats?.totalFeeClaimed, 4) + ' SOL';
  document.getElementById('s-cycle').textContent = '#' + (d.cycleCount || 0);
  document.getElementById('s-last').textContent = d.lastCycleAt || '—';

  // PnL
  const totalPnl = (d.activePositions || []).reduce((s,p) => s + (p.pnlPercent||0), 0);
  const pnlEl = document.getElementById('s-pnl');
  pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + fmt(totalPnl, 2) + '%';
  pnlEl.style.color = totalPnl >= 0 ? 'var(--green)' : 'var(--red)';

  // Positions
  document.getElementById('pos-count').textContent = d.activePositions.length;
  const posEl = document.getElementById('positions-list');
  if (!d.activePositions.length) {
    posEl.innerHTML = '<div class="empty">No active positions</div>';
  } else {
    posEl.innerHTML = d.activePositions.map(p => {
      const inRange = p.isInRange !== false;
      const pnlColor = (p.pnlPercent||0) >= 0 ? 'var(--green)' : 'var(--red)';
      const held = p.hoursHeld ? p.hoursHeld.toFixed(1) + 'h' : '—';
      return \`<div class="pos-card">
        <div class="pos-indicator" style="--range-color:\${inRange ? 'var(--green)' : 'var(--red)'}"></div>
        <div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <div class="pos-name">\${p.poolName}</div>
            <span class="range-badge \${inRange ? 'in-range' : 'out-range'}">\${inRange ? '✓ IN RANGE' : '✗ OUT'}</span>
          </div>
          <div class="pos-meta">
            <span class="pos-tag">⚡ \${p.strategyType || 'BidAsk'}</span>
            <span class="pos-tag">⏱ \${held}</span>
            <span class="pos-tag">💸 \${fmt(p.solDeposited,3)} SOL in</span>
            <span class="pos-tag">💰 \${fmt(p.feeEarned,4)} SOL fee</span>
          </div>
        </div>
        <div class="pos-stats">
          <div>
            <div class="ps-label">PnL</div>
            <div class="ps-val" style="color:\${pnlColor}">\${(p.pnlPercent||0) >= 0 ? '+' : ''}\${fmt(p.pnlPercent,2)}%</div>
          </div>
          <div>
            <div class="ps-label">Opened</div>
            <div class="ps-val" style="font-size:11px;color:var(--muted)">\${p.openedAt ? new Date(p.openedAt).toLocaleTimeString('id-ID') : '—'}</div>
          </div>
        </div>
      </div>\`;
    }).join('');
  }

  // Pool scan table
  const pools = d.topPools || [];
  document.getElementById('pool-count').textContent = pools.length + ' pools';
  if (d.lastScanAt) document.getElementById('scan-time').textContent = 'Last scan: ' + d.lastScanAt;
  const tbody = document.getElementById('pool-table-body');
  if (!pools.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">Waiting for scan...</td></tr>';
  } else {
    tbody.innerHTML = pools.slice(0,10).map((p, i) => \`
      <tr>
        <td style="color:var(--muted)">\${i+1}</td>
        <td><b>\${p.name}</b></td>
        <td class="mono">\${p.organicScore||0}</td>
        <td class="mono">\${(p.holders||0).toLocaleString()}</td>
        <td class="mono">\${fmtK(p.marketCapUsd)}</td>
        <td class="mono" style="color:var(--amber)">\${Number(p.feeActiveTvlRatio||0).toFixed(4)}</td>
        <td class="mono">\${fmtK(p.volume)}</td>
        <td style="font-size:11px;color:var(--cyan)">\${p.strategy||'—'}</td>
        <td>
          <div class="score-bar">
            <div class="score-fill" style="width:\${(p.compositeScore||0)*0.6}px"></div>
            <span class="mono" style="font-size:11px">\${p.compositeScore||0}</span>
          </div>
        </td>
      </tr>
    \`).join('');
  }

  // Fee table
  const feePositions = d.feeStats?.positions || {};
  const feeTbody = document.getElementById('fee-table-body');
  const feeEntries = Object.entries(feePositions);
  if (!feeEntries.length) {
    feeTbody.innerHTML = '<tr><td colspan="3" class="empty">No fee claims yet</td></tr>';
  } else {
    feeTbody.innerHTML = feeEntries.map(([addr, data]: any) => \`
      <tr>
        <td class="mono" style="color:var(--muted)">\${addr.slice(0,16)}...</td>
        <td class="mono" style="color:var(--green)">\${fmt(data.totalFee,6)} SOL</td>
        <td class="mono">\${data.claimCount}x</td>
      </tr>
    \`).join('');
  }
}

// Initial load via REST
fetch('/api/state').then(r=>r.json()).then(render).catch(()=>{});
connect();
</script>
</body>
</html>`;
function startDashboard(port = 3000) {
    const server = http_1.default.createServer((req, res) => {
        if (req.url === '/api/state') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ ...currentState, feeStats: (0, feeTracker_1.getCompoundStats)() }));
        }
        else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(HTML);
        }
    });
    // WebSocket server untuk real-time push
    let wss;
    try {
        wss = new ws_1.WebSocketServer({ server });
        wss.on('connection', (ws) => {
            clients.add(ws);
            // Kirim state saat ini langsung
            ws.send(JSON.stringify({ ...currentState, feeStats: (0, feeTracker_1.getCompoundStats)() }));
            ws.on('close', () => clients.delete(ws));
            ws.on('error', () => clients.delete(ws));
        });
    }
    catch {
        console.log('   WebSocket tidak tersedia, pakai polling');
    }
    server.listen(port, () => {
        console.log(`\n🌐 Dashboard: http://localhost:${port}`);
    });
    return server;
}
//# sourceMappingURL=server.js.map