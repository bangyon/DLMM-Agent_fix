import { ActivePosition, PositionStatus } from '../modules/positionManager';
import { StrategyDecision } from '../agent/brain';

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramAlert {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    this.enabled = !!(this.botToken && this.chatId);

    if (this.enabled) {
      console.log('✅ Telegram alerts aktif');
    } else {
      console.log('⚠️  Telegram alerts nonaktif (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diset)');
    }
  }

  private async send(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<void> {
    if (!this.enabled) return;
    try {
      await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: parseMode }),
      });
    } catch (err) {
      console.error('⚠️  Telegram send error:', err);
    }
  }

  async alertAgentStart(walletAddress: string, solBalance: number) {
    await this.send(
      `🤖 <b>DLMM Agent Mulai</b>\n\n` +
      `👛 Wallet: <code>${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}</code>\n` +
      `💰 Saldo: <b>${solBalance.toFixed(4)} SOL</b>\n` +
      `⏰ ${new Date().toLocaleString('id-ID')}`
    );
  }

  async alertPositionOpened(position: ActivePosition, decision: StrategyDecision) {
    await this.send(
      `📥 <b>Posisi Dibuka</b>\n\n` +
      `🏊 Pool: <b>${position.poolName}</b>\n` +
      `📊 Strategy: <code>${position.strategyType}</code>\n` +
      `📏 Bin Range: ±${position.binRange}\n` +
      `💸 SOL: <b>${position.solDeposited} SOL</b>\n` +
      `🤖 AI Confidence: ${decision.confidence}%\n` +
      `💬 <i>${decision.reasoning}</i>\n` +
      `🔑 <code>${position.positionKey.publicKey.toBase58().slice(0, 16)}...</code>`
    );
  }

  async alertPositionClosed(position: ActivePosition, pnlPercent: number, feeEarned: number, reason: string) {
    const pnlEmoji = pnlPercent >= 0 ? '🟢' : '🔴';
    const durationMin = Math.round((Date.now() - position.openedAt.getTime()) / 60000);

    await this.send(
      `📤 <b>Posisi Ditutup</b>\n\n` +
      `🏊 Pool: <b>${position.poolName}</b>\n` +
      `${pnlEmoji} PnL: <b>${pnlPercent.toFixed(2)}%</b>\n` +
      `💰 Fee Earned: <b>${feeEarned.toFixed(4)} SOL</b>\n` +
      `⏱ Durasi: ${durationMin} menit\n` +
      `💬 <i>${reason}</i>`
    );
  }

  async alertOutOfRange(position: ActivePosition, pnlPercent: number) {
    await this.send(
      `⚠️ <b>Posisi Out of Range!</b>\n\n` +
      `🏊 Pool: <b>${position.poolName}</b>\n` +
      `📉 PnL saat ini: ${pnlPercent.toFixed(2)}%\n` +
      `💬 <i>Agent sedang mempertimbangkan rebalance...</i>`
    );
  }

  async alertHighBundlerRisk(poolName: string, poolAddress: string, score: number, reasons: string[]) {
    await this.send(
      `🚨 <b>MEV Risk Tinggi Terdeteksi</b>\n\n` +
      `🏊 Pool: <b>${poolName}</b>\n` +
      `⚠️ Suspicion Score: <b>${score}/100</b>\n` +
      `📋 Temuan:\n` + reasons.map(r => `• ${r}`).join('\n') + '\n' +
      `🔒 Agent skip pool ini untuk keamanan`
    );
  }

  async alertCycleSummary(cycle: number, positions: PositionStatus[], solBalance: number) {
    if (positions.length === 0) return;

    const totalPnl = positions.reduce((s, p) => s + p.pnlPercent, 0) / positions.length;
    const totalFee = positions.reduce((s, p) => s + p.feeEarned, 0);
    const inRangeCount = positions.filter(p => p.isInRange).length;

    await this.send(
      `📊 <b>Cycle #${cycle} Summary</b>\n\n` +
      `💰 Saldo: <b>${solBalance.toFixed(4)} SOL</b>\n` +
      `📌 Posisi aktif: ${positions.length}\n` +
      `✅ Dalam range: ${inRangeCount}/${positions.length}\n` +
      `📈 Avg PnL: ${totalPnl.toFixed(2)}%\n` +
      `💸 Total fee: ${totalFee.toFixed(4)} SOL\n` +
      `⏰ ${new Date().toLocaleString('id-ID')}`
    );
  }

  async alertError(message: string, context?: string) {
    await this.send(
      `❌ <b>Error</b>\n\n` +
      `${message}\n` +
      (context ? `<code>${context.slice(0, 200)}</code>` : '')
    );
  }
}
