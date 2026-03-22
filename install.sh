#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     DLMM Agent — Meteora LP Bot        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "${RED}❌ Node.js tidak ditemukan. Install dulu: https://nodejs.org${NC}"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}❌ Node.js >= 18 diperlukan. Versi saat ini: $(node -v)${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v) detected${NC}"

# Clone atau update repo
if [ -d "dlmm-agent-test" ]; then
  echo -e "${YELLOW}📦 Folder sudah ada, update...${NC}"
  cd dlmm-agent-test
  git pull origin main
else
  echo -e "${YELLOW}📦 Cloning repo...${NC}"
  git clone https://github.com/bangyon/dlmm-agent-test.git
  cd dlmm-agent-test
fi

# Install dependencies
echo -e "${YELLOW}📦 Installing dependencies...${NC}"
npm install --silent

# Setup .env
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ""
  echo -e "${YELLOW}⚙️  Setup konfigurasi:${NC}"
  echo ""

  # Private Key
  echo -e "${BLUE}1. Masukkan Private Key wallet Solana (base58):${NC}"
  read -s PRIVATE_KEY
  sed -i.bak "s/PRIVATE_KEY=.*/PRIVATE_KEY=$PRIVATE_KEY/" .env

  # RPC URL
  echo -e "${BLUE}2. Masukkan RPC URL (Enter untuk pakai default Helius free):${NC}"
  echo -e "   Default: https://mainnet.helius-rpc.com (rate limited)"
  read RPC_URL
  if [ ! -z "$RPC_URL" ]; then
    sed -i.bak "s|RPC_URL=.*|RPC_URL=$RPC_URL|" .env
  fi

  # Groq API Key
  echo -e "${BLUE}3. Masukkan Groq API Key (gratis di console.groq.com):${NC}"
  read GROQ_KEY
  sed -i.bak "s/GROQ_API_KEY=.*/GROQ_API_KEY=$GROQ_KEY/" .env

  # Telegram (opsional)
  echo -e "${BLUE}4. Telegram Bot Token (Enter untuk skip):${NC}"
  read TG_TOKEN
  if [ ! -z "$TG_TOKEN" ]; then
    sed -i.bak "s/TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$TG_TOKEN/" .env
    echo -e "${BLUE}   Telegram Chat ID:${NC}"
    read TG_CHAT
    sed -i.bak "s/TELEGRAM_CHAT_ID=.*/TELEGRAM_CHAT_ID=$TG_CHAT/" .env
  fi

  # LP Agent (opsional)
  echo -e "${BLUE}5. LP Agent API Key (Enter untuk skip):${NC}"
  read LP_KEY
  if [ ! -z "$LP_KEY" ]; then
    sed -i.bak "s/LP_AGENT_API_KEY=.*/LP_AGENT_API_KEY=$LP_KEY/" .env
  fi

  # SOL per position
  echo -e "${BLUE}6. SOL per posisi (default: 0.1):${NC}"
  read SOL_POS
  if [ ! -z "$SOL_POS" ]; then
    sed -i.bak "s/SOL_PER_POSITION=.*/SOL_PER_POSITION=$SOL_POS/" .env
  fi

  rm -f .env.bak
  echo ""
  echo -e "${GREEN}✅ Konfigurasi tersimpan di .env${NC}"
else
  echo -e "${GREEN}✅ .env sudah ada, skip setup${NC}"
fi

# Create data directory
mkdir -p data

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     ✅ Install selesai!                 ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "Jalankan bot dengan:"
echo -e "${BLUE}  cd dlmm-agent-test && npm run dev${NC}"
echo ""
echo -e "Dashboard: ${BLUE}http://localhost:3000${NC}"
echo ""

# Tanya mau langsung jalankan
echo -e "${YELLOW}Jalankan bot sekarang? (y/n):${NC}"
read RUN_NOW
if [ "$RUN_NOW" = "y" ] || [ "$RUN_NOW" = "Y" ]; then
  npm run dev
fi
