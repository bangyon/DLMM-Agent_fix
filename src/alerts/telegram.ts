import { ActivePosition, PositionStatus } from '../modules/positionManager';
import { StrategyDecision } from '../agent/brain';
import { PoolInfo } from '../modules/poolFinder';

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramAlert {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;
  private pendingCallback: ((poolIndex: number) => void) | null = null;
  private pollOffset = 0;
  private isPolling = false;
  private commandHandler: ((cmd: string) => void) | null = null;
  private isPaused = false;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID || '';
    this.enabled = !!(this.botToken && this.chatId);
    if (this.enabled) {
      console.log('✅ Telegram alerts aktif');
      this.startPolling();
    } else {
      console.log('⚠️  Telegram alerts nonaktif');
    }
  }

  // ── Core send ──────────────────────────────────────────────────────────────
  async send(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML', extra: any = {}): Promise<any> {
    if (!this.enabled) return null;
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: parseMode, ...extra }),
      });
      return await res.json();
    } catch (err) {
      console.error('⚠️  Telegram error:', err);
      return null;
    }
  }

  private async answerCallback(callbackQueryId: string, text = '✅') {
    if (!this.enabled) return;
    try {
      await fetch(`${TELEGRAM_API}/bot${this.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
    } catch {}
  }

  // ── Long polling untuk terima callback dari inline keyboard ───────────────
  private async startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;

    const poll = async () => {
      while (this.isPolling) {
        try {
          const res = await fetch(
            `${TELEGRAM_API}/bot${this.botToken}/getUpdates?offset=${this.pollOffset}&timeout=10&allowed_updates=["callback_query","message"]`
          );
          const data = await res.json() as any;

          for (const update of data.result || []) {
            this.pollOffset = update.update_id + 1;

            // Handle callback query (inline keyboard press)
            if (update.callback_query) {
              const cb = update.callback_query;
              await this.answerCallback(cb.id);
              const data = cb.data || '';

              if (data.startsWith('open_pool:') && this.pendingCallback) {
                const idx = parseInt(data.split(':')[1]);
                console.log(`\n📱 Telegram: user pilih pool #${idx + 1}`);
                this.pendingCallback(idx);
                this.pendingCallback = null;
              } else if (data === 'skip_all' && this.pendingCallback) {
                console.log(`\n📱 Telegram: user skip semua pool`);
                this.pendingCallback(-1);
                this.pendingCallback = null;
              }
            }

            // Handle text message commands
            if (update.message?.text) {
              const cmd = update.message.text.toLowerCase().trim();
              console.log(`\n📱 Telegram command: ${cmd}`);

              if (cmd === '/status') {
                await this.send('📊 Bot berjalan\nGunakan: /positions /pause /resume /close /memory');
              } else if (cmd === '/pause') {
                this.isPaused = true;
                await this.send('⏸ Bot di-pause — tidak akan buka posisi baru\nKirim /resume untuk lanjut');
                if (this.commandHandler) this.commandHandler('pause');
              } else if (cmd === '/resume') {
                this.isPaused = false;
                await this.send('▶️ Bot di-resume — kembali normal');
                if (this.commandHandler) this.commandHandler('resume');
              } else if (cmd === '/close') {
                await this.send('🔴 Menutup semua posisi aktif...');
                if (this.commandHandler) this.commandHandler('close_all');
              } else if (cmd === '/positions') {
                if (this.commandHandler) this.commandHandler('get_positions');
              } else if (cmd === '/memory') {
                if (this.commandHandler) this.commandHandler('get_memory');
              } else if (cmd === '/help') {
                await this.send(
                  '📖 <b>Commands:</b>\n' +
                  '/status — status bot\n' +
                  '/positions — posisi aktif\n' +
                  '/pause — pause buka posisi baru\n' +
                  '/resume — resume bot\n' +
                  '/close — close semua posisi\n' +
                  '/memory — pool win rate history'
                );
              }
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
    };

    poll().catch(() => {});
  }

  // ── Pool scan notification dengan inline keyboard ─────────────────────────
  async askPoolSelection(
    pools: PoolInfo[],
    aiDecision: StrategyDecision,
    solBalance: number
  ): Promise<number> {
    if (!this.enabled) return 0; // auto-pick first pool jika telegram tidak aktif

    const top = pools.slice(0, 5);
    const poolList = top.map((p, i) =>
      `${i + 1}. <b>${p.name}</b>\n` +
      `   Organic: ${p.organicScore}/100 | Holders: ${p.holders.toLocaleString()}\n` +
      `   Fee/TVL: ${p.feeActiveTvlRatio.toFixed(4)} | Vol: $${p.volume.toFixed(0)}\n` +
      `   MCap: $${(p.marketCapUsd/1000).toFixed(0)}K | Strategy: ${p.strategy}\n` +
      `   Score: ${p.compositeScore}/100`
    ).join('\n\n');

    const msg =
      `🔍 <b>Pool Scan Result</b>\n\n` +
      `💰 Saldo: <b>${solBalance.toFixed(4)} SOL</b>\n` +
      `🤖 AI Confidence: <b>${aiDecision.confidence}%</b> (threshold 80%)\n` +
      `💬 <i>${aiDecision.reasoning}</i>\n\n` +
      `📊 <b>Top Pool Candidates:</b>\n\n` +
      poolList + '\n\n' +
      `Pilih pool mana yang mau dibuka?`;

    // Inline keyboard — 1 button per pool + skip
    const keyboard = [
      ...top.map((p, i) => [{ text: `${i+1}. ${p.name} (${p.compositeScore}pts)`, callback_data: `open_pool:${i}` }]),
      [{ text: '❌ Skip semua', callback_data: 'skip_all' }],
    ];

    await this.send(msg, 'HTML', {
      reply_markup: { inline_keyboard: keyboard },
    });

    // Tunggu response dari user (max 5 menit)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('\n⏰ Telegram timeout — auto-skip');
        this.pendingCallback = null;
        resolve(-1);
      }, 5 * 60 * 1000);

      this.pendingCallback = (idx: number) => {
        clearTimeout(timeout);
        resolve(idx);
      };
    });
  }

  // ── Pool scan summary (selalu kirim, tanpa nanya) ─────────────────────────
  async alertPoolScan(pools: PoolInfo[], cycle: number) {
    if (!this.enabled || pools.length === 0) return;
    const top = pools.slice(0, 3);
    const list = top.map((p, i) =>
      `${i+1}. <b>${p.name}</b> — Score ${p.compositeScore}/100\n` +
      `   Organic ${p.organicScore} | Fee/TVL ${p.feeActiveTvlRatio.toFixed(4)} | ${p.strategy}`
    ).join('\n');

    await this.send(
      `🔄 <b>Scan #${cycle}</b>\n\n${list}\n\n<i>Menunggu keputusan AI...</i>`
    );
  }

  // ── Standard alerts ────────────────────────────────────────────────────────
  async alertAgentStart(walletAddress: string, solBalance: number) {
    await this.send(
      `🤖 <b>DLMM Agent Mulai</b>\n\n` +
      `👛 Wallet: <code>${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}</code>\n` +
      `💰 Saldo: <b>${solBalance.toFixed(4)} SOL</b>\n` +
      `⏰ ${new Date().toLocaleString('id-ID')}\n\n` +
      `Commands: /status`
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
      `📉 PnL: ${pnlPercent.toFixed(2)}%`
    );
  }

  async alertHighBundlerRisk(poolName: string, poolAddress: string, score: number, reasons: string[]) {
    await this.send(
      `🚨 <b>MEV Risk Tinggi</b>\n\n` +
      `🏊 Pool: <b>${poolName}</b>\n` +
      `⚠️ Score: <b>${score}/100</b>\n` +
      reasons.map(r => `• ${r}`).join('\n')
    );
  }

  async alertCycleSummary(cycle: number, positions: PositionStatus[], solBalance: number) {
    if (positions.length === 0) return;
    const totalFee = positions.reduce((s, p) => s + p.feeEarned, 0);
    const inRange = positions.filter(p => p.isInRange).length;
    await this.send(
      `📊 <b>Cycle #${cycle}</b>\n\n` +
      `💰 Saldo: <b>${solBalance.toFixed(4)} SOL</b>\n` +
      `📌 Posisi: ${positions.length} (${inRange} in range)\n` +
      `💸 Fee: ${totalFee.toFixed(4)} SOL`
    );
  }

  async alertError(message: string, context?: string) {
    await this.send(
      `❌ <b>Error</b>\n\n${message}\n` +
      (context ? `<code>${context.slice(0, 200)}</code>` : '')
    );
  }

  async alertInfo(message: string) {
    await this.send(`ℹ️ ${message}`);
  }

  setCommandHandler(handler: (cmd: string) => void) {
    this.commandHandler = handler;
  }

  getBotPaused(): boolean {
    return this.isPaused;
  }
}
