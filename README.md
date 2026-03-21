# 🤖 DLMM Agent — Meteora LP Manager

Bot AI untuk manajemen liquidity otomatis di Meteora DLMM. Isi SOL, jalankan, bot yang urus sisanya.

---

## ✨ Fitur Lengkap

| Modul | Deskripsi |
|---|---|
| 🔎 **Pool Finder** | Fetch & rank pool terbaik dari Meteora API (fee APR, volume, TVL) |
| 🧠 **AI Brain** | LLM pilih strategy, bin range, kapan open/close/rebalance |
| 🛡️ **Bundler Checker** | Deteksi MEV, sandwich attacker, bot pattern |
| 📊 **Position Manager** | Open, monitor, rebalance, close posisi DLMM otomatis |
| 💰 **Auto Claim Fee** | Claim fee setiap cycle jika di atas threshold |
| 🔄 **Jupiter Integration** | Price data & swap SOL ↔ token untuk rebalancing |
| 📈 **Backtesting** | Simulasi strategy di data historis sebelum live |
| 🌐 **Dashboard UI** | Web dashboard real-time di `localhost:3000` |
| 📲 **Telegram Alerts** | Notifikasi open/close posisi, out of range, summary |

---

## 🚀 Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Buat file `.env`

```bash
cp .env.example .env
```

Isi bagian wajib:

```env
# Wallet private key (base58)
PRIVATE_KEY=your_private_key_here

# RPC — Helius direkomendasikan
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# AI Provider (pilih salah satu)
OPENROUTER_API_KEY=sk-or-...
AI_PROVIDER=openrouter
AI_MODEL=anthropic/claude-3-haiku
```

### 3. (Opsional) Setup Telegram Bot

1. Chat `@BotFather` di Telegram → `/newbot` → copy token
2. Chat `@userinfobot` → copy Chat ID kamu
3. Isi di `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
```

---

## 🎮 Cara Pakai

### Backtest dulu sebelum live (direkomendasikan)

```bash
# Backtest 7 hari (default)
npm run backtest

# Backtest 14 hari
npm run backtest:14
```

Output backtest membandingkan top 3 pool dan menampilkan:
- % waktu posisi in range
- Estimasi fee APR
- Estimasi Impermanent Loss
- Net return (fee - IL)
- Optimal bin range

### Jalankan agent live

```bash
# Development
npm run dev

# Production
npm run build && npm start
```

### Lihat laporan fee

```bash
npm run report
```

---

## 🌐 Dashboard

Buka browser ke **http://localhost:3000** setelah agent berjalan.

Dashboard menampilkan:
- Saldo SOL real-time
- Status semua posisi aktif (in/out range, PnL, fee earned)
- Total fee claimed
- History per pool
- Auto-refresh setiap 15 detik

---

## ⚙️ Konfigurasi Agent

| Variable | Default | Keterangan |
|---|---|---|
| `SOL_PER_POSITION` | `0.1` | SOL per posisi LP |
| `MAX_POSITIONS` | `3` | Max posisi aktif bersamaan |
| `CHECK_INTERVAL_SECONDS` | `60` | Interval cycle (detik) |
| `MIN_FEE_APR` | `20` | Min fee APR (%) untuk masuk pool |
| `MAX_LOSS_PERCENT` | `5` | Max loss sebelum auto-close (%) |
| `DASHBOARD_PORT` | `3000` | Port dashboard web |

---

## 🤖 AI Providers

| Provider | Model | Kecepatan | Biaya | Rekomendasi |
|---|---|---|---|---|
| **Groq** | `llama3-70b-8192` | ⚡ Sangat cepat | Gratis | Mulai dari sini |
| **OpenRouter** | `anthropic/claude-3-haiku` | 🏃 Cepat | ~$0.001/call | Kualitas terbaik |
| **Anthropic** | `claude-3-haiku-20240307` | 🏃 Cepat | ~$0.001/call | Langsung ke Anthropic |

---

## 📁 Struktur Project

```
src/
├── index.ts                  # Entry point (--backtest, --report, live)
├── config/index.ts           # Load & validasi .env
├── agent/
│   ├── brain.ts              # AI client — OpenRouter / Groq / Anthropic
│   └── orchestrator.ts       # Main loop, koordinasi semua modul
├── modules/
│   ├── poolFinder.ts         # Fetch & rank pool dari Meteora API
│   ├── bundlerChecker.ts     # Deteksi MEV & bundler activity
│   ├── positionManager.ts    # Open/close/monitor posisi via DLMM SDK
│   └── jupiter.ts            # Price data & swap via Jupiter v6
├── alerts/
│   └── telegram.ts           # Notifikasi Telegram
├── backtest/
│   └── simulator.ts          # Simulasi strategy di data historis
├── dashboard/
│   └── server.ts             # Web dashboard (http server)
└── utils/
    └── feeTracker.ts         # Claim fee & tracking statistik

data/                         # Auto-dibuat saat runtime
├── fee-stats.json            # Akumulasi statistik fee
└── fee-log.jsonl             # Log setiap claim fee
```

---

## ⚠️ Disclaimer

Bot ini untuk eksperimen dan edukasi. LP di DLMM mengandung risiko:
- **Impermanent Loss** — terutama saat posisi out of range
- **Smart contract risk** — gunakan SOL yang siap kamu risikoin
- **Market risk** — harga bisa bergerak drastis

Selalu pantau bot secara berkala dan mulai dengan SOL kecil dulu.
