# DLMM Agent — Meteora LP Bot

Automated LP bot untuk Meteora DLMM di Solana. Strategy berbasis LP Army bear market guide dengan AI decision making (Groq).

## Features
- 🤖 AI-powered entry/exit decisions (Groq)
- 📊 Real-time pool scanning via Meteora pagination API
- 🔄 BidAsk Flip detection (SOL → token auto-flip)
- 💰 Position persistence (survive restart)
- 📱 Telegram alerts
- 🌐 Dashboard di localhost:3000
- 🛡️ Multi-layer protection (rug check, MEV detection, mcap filter)

## Requirements
- Node.js >= 18
- Solana wallet dengan SOL (min 0.3 SOL recommended)
- Groq API key (gratis di console.groq.com)
- Telegram bot token (opsional)

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/bangyon/dlmm-agent-test/main/install.sh | bash
```

## Manual Install

```bash
git clone https://github.com/bangyon/dlmm-agent-test.git
cd dlmm-agent-test
npm install
cp .env.example .env
# Edit .env dengan credentials kamu
npm run dev
```

## Setup .env

```env
PRIVATE_KEY=your_wallet_private_key_base58
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
GROQ_API_KEY=gsk_your_groq_key
TELEGRAM_BOT_TOKEN=your_bot_token (opsional)
TELEGRAM_CHAT_ID=your_chat_id (opsional)
SOL_PER_POSITION=0.1
MAX_POSITIONS=1
MIN_FEE_APR=50
DEFAULT_BIN_RANGE=34
MAX_LOSS_PERCENT=8
```

## Strategy

Bot menggunakan 3 strategy dari LP Army bear market guide:
1. **SPOT_PUMP** — token sedang pump, max hold 2 jam
2. **SPOT_DUMP** — token dump >50% lalu retrace, max hold 3 jam  
3. **BIDASK_FLIP** — pool >3 hari stabil, auto-flip SOL↔token

## Dashboard

Buka http://localhost:3000 saat bot berjalan.
