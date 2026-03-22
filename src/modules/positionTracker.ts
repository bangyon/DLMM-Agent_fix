import { ActivePosition, PositionStatus } from './positionManager';

export interface PositionTrack {
  position: ActivePosition;
  openPrice: number;
  highestPrice: number;    // untuk trailing stop
  lastRebalanceAt: Date;
  hoursHeld: number;
  feeAccumulated: number;
  rebalanceCount: number;
}

const MAX_HOLD_HOURS_DEFAULT = 2;
const MAX_HOLD_HOURS_BIDASK = 6;
const TRAILING_STOP_PCT = 15;       // Close jika harga turun 15% dari peak
const MIN_REBALANCE_INTERVAL = 2;   // Minimal 2 jam antara rebalance

export class PositionTracker {
  private tracks = new Map<string, PositionTrack>();

  addPosition(position: ActivePosition, currentPrice: number) {
    this.tracks.set(position.positionKey.publicKey.toBase58(), {
      position,
      openPrice: currentPrice,
      highestPrice: currentPrice,
      lastRebalanceAt: new Date(),
      hoursHeld: 0,
      feeAccumulated: 0,
      rebalanceCount: 0,
    });
  }

  removePosition(positionKey: string) {
    this.tracks.delete(positionKey);
  }

  updateTrack(positionKey: string, currentPrice: number, feeEarned: number) {
    const track = this.tracks.get(positionKey);
    if (!track) return;

    track.highestPrice = Math.max(track.highestPrice, currentPrice);
    track.hoursHeld = (Date.now() - track.position.openedAt.getTime()) / 3600000;
    track.feeAccumulated = feeEarned;
  }

  shouldClose(positionKey: string, currentPrice: number, pnlPercent: number): {
    should: boolean;
    reason: string;
  } {
    const track = this.tracks.get(positionKey);
    if (!track) return { should: false, reason: '' };

    // 1. Max hold duration — bear market: lebih pendek
    // BidAsk Flip: 6 jam, Spot play: 2 jam
    const isBidAsk = track.position.strategyType?.toString().includes('BidAsk');
    const maxHold = isBidAsk ? MAX_HOLD_HOURS_BIDASK : MAX_HOLD_HOURS_DEFAULT;
    if (track.hoursHeld >= maxHold) {
      return {
        should: true,
        reason: `Max hold ${maxHold}h tercapai (${track.hoursHeld.toFixed(1)}h) — lock profit, re-enter fresh`,
      };
    }

    // 2. Trailing stop: harga turun X% dari peak
    if (track.highestPrice > 0) {
      const dropFromPeak = ((track.highestPrice - currentPrice) / track.highestPrice) * 100;
      if (dropFromPeak > TRAILING_STOP_PCT && pnlPercent < -5) {
        return {
          should: true,
          reason: `Trailing stop: harga turun ${dropFromPeak.toFixed(1)}% dari peak (${track.highestPrice.toFixed(6)} → ${currentPrice.toFixed(6)})`,
        };
      }
    }

    return { should: false, reason: '' };
  }

  shouldRebalance(positionKey: string, isOutOfRange: boolean): {
    should: boolean;
    reason: string;
  } {
    const track = this.tracks.get(positionKey);
    if (!track) return { should: false, reason: '' };

    // Cek interval minimum
    const hoursSinceRebalance = (Date.now() - track.lastRebalanceAt.getTime()) / 3600000;
    if (hoursSinceRebalance < MIN_REBALANCE_INTERVAL) {
      return { should: false, reason: '' };
    }

    // Out of range > 2 jam → rebalance
    if (isOutOfRange && hoursSinceRebalance >= 2) {
      return {
        should: true,
        reason: `Out of range selama ${hoursSinceRebalance.toFixed(1)}h — rebalance ke range baru`,
      };
    }

    return { should: false, reason: '' };
  }

  markRebalanced(positionKey: string) {
    const track = this.tracks.get(positionKey);
    if (!track) return;
    track.lastRebalanceAt = new Date();
    track.rebalanceCount++;
  }

  getTrack(positionKey: string): PositionTrack | undefined {
    return this.tracks.get(positionKey);
  }

  getSummary(): string {
    if (this.tracks.size === 0) return 'Tidak ada posisi aktif';
    return Array.from(this.tracks.values()).map(t =>
      `${t.position.poolName}: held ${t.hoursHeld.toFixed(1)}h, fee ${t.feeAccumulated.toFixed(4)} SOL, rebalance ${t.rebalanceCount}x`
    ).join('\n');
  }
}
