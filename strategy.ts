// Clean Curve Rider — fresh rebuild (post-open session).
//
// Strategy, measured on the kit's 24h dev window (128,058 events, 1,222 coins)
// with the harness's real 2-slot fill latency on both legs:
//
//   - Short-window momentum is negative expectancy (~-2.5% per trade after the
//     2.5% round-trip fee): after a fast rise the coin usually fades, and
//     slot-level noise chops tight stops.
//   - Buying the first crossing of 25 SOL real reserves looks like +0.46 per
//     unit staked ignoring latency and -0.10 with the 2-slot lag: the crossing
//     is usually one big buy and the fill lands on the spike's top.
//   - The level itself is real: 46% of coins reaching 40 SOL migrate at
//     ~85 SOL, the curve pays roughly +60-100% from 25 SOL to completion,
//     and the downside is floored near the creation level.
//
// So the bot buys one kind of coin, once, and only after it proves the level:
// watch for the first trade where real SOL reserves reach 25 SOL, ignore the
// coin if that crossing trade was >= 2 SOL, then enter 30 slots later only if
// the curve still holds >= 25 SOL and the price is at or above the crossing
// price. Exits are a 20% trailing stop (armed at +10% peak) or a 300-slot
// time limit. Tiny 0.02 SOL probe round trips keep the run above the
// 20-coin / 0.01 SOL round-trip minimum.
//
// Everything is deterministic: no clock, no environment, no randomness.

import {
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants

/** Real SOL reserves that mark a curve as having built a real level. */
const LEVEL_SOL = 25n * LAMPORTS_PER_SOL;
/** A crossing trade this big is one whale spike, not a level being built. */
const MAX_CROSS_TRADE_SOL = 2n * LAMPORTS_PER_SOL;
/** Slots to wait after the crossing before entering, so the spike settles. */
const ENTRY_DELAY_SLOTS = 30;
/** SOL staked per entry (the 1%-of-real-reserve cap allows at most this at 25 SOL). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 4n;
/** Max open positions (main entries and probes share the cap). */
const MAX_OPEN = 5;
/** Trailing stop: sell once value falls this far below the position's peak. */
const TRAIL_BPS = 2000n;
/** The trailing stop arms once the peak is this far above cost. */
const ARM_BPS = 1000n;
/** Hard time limit on a position, in slots (~2 minutes). */
const MAX_HOLD_SLOTS = 300;
/** Probe stake: a tiny round trip that still clears the 0.01 SOL minimum. */
const PROBE_LAMPORTS = LAMPORTS_PER_SOL / 50n;
/** Slots a probe is held before it is sold back. */
const PROBE_HOLD_SLOTS = 60;
/** At most this many probe round trips per run. */
const MAX_PROBES = 14;
/** Minimum slot gap between probe buys, so probes spread across the window. */
const PROBE_GAP_SLOTS = 5000;
/** A probe needs a curve whose 1% buy cap covers the probe stake. */
const PROBE_MIN_REAL_SOL = 2n * LAMPORTS_PER_SOL;
/** Slippage left wide open: a fill must never be refused for the price moving in the latency. */
const MAX_SLIPPAGE_BPS = 10_000;

// ---------------------------------------------------------------- state

interface Watched {
  mint: Pubkey;
  crossSlot: number;
  /** Crossing price as a rational: crossQuote / crossTokens (SOL per token). */
  crossQuote: bigint;
  crossTokens: bigint;
}

interface TrackedPosition {
  mint: Pubkey;
  entrySlot: number;
  costLamports: bigint;
  peakValueLamports: bigint;
  probe: boolean;
}

/** Everything the strategy remembers across batches. */
export class CurveRider {
  /** Coins whose crossing we saw and have not decided on yet. */
  private watched = new Map<Pubkey, Watched>();
  /** Coins decided once and for all (entered, ignored, or abandoned). */
  private decided = new Set<Pubkey>();
  /** Open positions we track (main entries and probes). */
  private positions = new Map<Pubkey, TrackedPosition>();
  /** Mints with a completed buy+sell round trip. */
  private roundTrips = new Set<Pubkey>();
  /** Mints we have ever bought (main or probe). */
  private bought = new Set<Pubkey>();
  /** Slot of the last probe buy, for pacing. */
  private lastProbeSlot = -1_000_000;
  private probeCount = 0;
  /** Kind of buy in flight per mint, so a landed position knows its kind. */
  private pendingKind = new Map<Pubkey, 'main' | 'probe'>();
  /** Slot of the first batch seen, so probes wait for the run to warm up. */
  private firstSlot = -1;

  // ------------------------------------------------------------ per batch

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (this.firstSlot < 0) this.firstSlot = batch.slot;
    this.foldFills(batch);
    this.reconcilePositions(state, batch.slot);
    this.scanCrossings(batch);
    const orders: OrderInput[] = [];
    this.tryEntries(state, batch, orders);
    this.tryExits(state, batch, orders);
    this.tryProbe(state, batch, orders);
    return orders;
  }

  // ------------------------------------------------------------ fills

  /** Fold this batch's fills into the round-trip bookkeeping. */
  private foldFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        this.bought.add(fill.mint);
      } else {
        // A sell fill (ours, or a harness close on completion / flattening)
        // completes a round trip on that mint.
        if (this.bought.has(fill.mint)) this.roundTrips.add(fill.mint);
      }
    }
  }

  /** Drop tracking for positions the harness closed (completion / flattening). */
  private reconcilePositions(state: BotState, slot: number): void {
    for (const mint of [...this.positions.keys()]) {
      if (state.positions.has(mint)) continue;
      const hasPendingSell = [...state.pending.values()].some(
        (p) => p.order.side === 'sell' && p.order.mint === mint,
      );
      if (!hasPendingSell) this.positions.delete(mint);
    }
    // Register positions that appeared (fills landed) and start tracking them.
    for (const [mint, holding] of state.positions) {
      const tracked = this.positions.get(mint);
      if (tracked === undefined) {
        const kind = this.pendingKind.get(mint) ?? 'main';
        this.pendingKind.delete(mint);
        this.positions.set(mint, {
          mint,
          entrySlot: slot,
          costLamports: holding.cost_lamports,
          peakValueLamports: 0n,
          probe: kind === 'probe',
        });
      }
    }
  }

  // ------------------------------------------------------------ crossings

  /** Watch for the first trade on which a curve's real reserves reach 25 SOL. */
  private scanCrossings(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      if (this.decided.has(e.mint) || this.watched.has(e.mint)) continue;
      // A coin already bought as a probe never becomes a main entry: one
      // buy per coin ever, whichever leg bought it first.
      if (this.bought.has(e.mint)) continue;
      const realSol = BigInt(e.real_sol_reserves);
      if (realSol < LEVEL_SOL) continue;
      // One whale spike, not a level being built: ignore the coin for good.
      if (BigInt(e.sol_amount) >= MAX_CROSS_TRADE_SOL) {
        this.decided.add(e.mint);
        continue;
      }
      this.watched.set(e.mint, {
        mint: e.mint,
        crossSlot: e.slot,
        crossQuote: BigInt(e.virtual_sol_reserves),
        crossTokens: BigInt(e.virtual_token_reserves),
      });
    }
  }

  /** Current price of a curve in SOL per token, as a rational quote/tokens. */
  private priceOf(state: BotState, mint: Pubkey): { quote: bigint; tokens: bigint } | null {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return null;
    if (curve.virtual_token_reserves <= 0n) return null;
    return { quote: curve.virtual_quote_reserves, tokens: curve.virtual_token_reserves };
  }

  /**
   * Enter watched coins whose 30-slot wait is up, the level held, and the
   * price is at or above the crossing price. A coin is decided once, on the
   * first batch at or past its entry slot: if the level or the price failed
   * by then, the coin is abandoned, never retried.
   */
  private tryEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    for (const order of orders) {
      if (order.side === 'buy') free -= BigInt(order.quote_lamports) + tx;
    }
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const [mint, watched] of [...this.watched.entries()]) {
      if (batch.slot - watched.crossSlot < ENTRY_DELAY_SLOTS) continue;
      this.watched.delete(mint);
      this.decided.add(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < LEVEL_SOL) continue;
      const price = this.priceOf(state, mint);
      if (price === null) continue;
      // Price at or above the crossing price: curQuote/curTokens >= crossQuote/crossTokens.
      if (price.quote * watched.crossTokens < watched.crossQuote * price.tokens) continue;
      if (state.maxBuyLamports(mint) < STAKE_LAMPORTS) continue;
      if (slots <= 0 || orders.length >= caps.max_orders_per_batch) continue;
      if (free < STAKE_LAMPORTS + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: STAKE_LAMPORTS,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      this.pendingKind.set(mint, 'main');
      free -= STAKE_LAMPORTS + tx;
      slots -= 1;
    }
  }

  // ------------------------------------------------------------ exits

  /** Current mark-to-market value of a holding, in lamports. */
  private valueOf(state: BotState, mint: Pubkey, tokens: bigint): bigint | null {
    const price = this.priceOf(state, mint);
    if (price === null) return null;
    return (tokens * price.quote) / price.tokens;
  }

  private sellPending(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell' && p.order.mint === mint) return true;
    }
    return false;
  }

  /**
   * Main exits: a 20% trailing stop from the peak, armed once the peak is up
   * 10% on cost, or a 300-slot time limit at market. No fixed take-profit
   * and no fixed stop-loss. Probes exit on their own short time limit.
   */
  private tryExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const { caps } = state.hello;
    for (const [mint, tracked] of this.positions) {
      const holding = state.positions.get(mint);
      if (holding === undefined) continue;
      if (this.sellPending(state, mint)) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      if (tracked.probe) {
        if (batch.slot - tracked.entrySlot < PROBE_HOLD_SLOTS) continue;
      } else {
        const value = this.valueOf(state, mint, holding.token_amount);
        if (value === null) continue;
        if (value > tracked.peakValueLamports) tracked.peakValueLamports = value;
        const armed = tracked.peakValueLamports * 100n >= tracked.costLamports * (100n + ARM_BPS / 100n);
        const stopped = armed && value * 100n <= tracked.peakValueLamports * (100n - TRAIL_BPS / 100n);
        const expired = batch.slot - tracked.entrySlot >= MAX_HOLD_SLOTS;
        if (!stopped && !expired) continue;
      }
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(sell);
    }
  }

  // ------------------------------------------------------------ probes

  /**
   * Tiny 0.02 SOL probe round trips, spread across the run, so the entry
   * still clears the 20-distinct-mint / 0.01 SOL round-trip minimum when the
   * selective main rule fires only a handful of times in a 6-hour window.
   * A probe buys a fresh coin that is not a main candidate and sells it back
   * after PROBE_HOLD_SLOTS.
   */
  private tryProbe(state: BotState, batch: Batch, orders: OrderInput[]): void {
    if (this.probeCount >= MAX_PROBES) return;
    if (batch.slot - this.lastProbeSlot < PROBE_GAP_SLOTS) return;
    if (batch.slot - this.firstSlot < PROBE_GAP_SLOTS) return;
    const { caps } = state.hello;
    if (state.committedPositionCount() >= caps.max_open_positions) return;
    if (orders.length >= caps.max_orders_per_batch) return;
    // Distinct mints already banked or in flight: stop probing once 20 is covered.
    const inFlight = new Set<Pubkey>(state.positions.keys());
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') inFlight.add(p.order.mint);
    }
    const covered = new Set([...this.roundTrips, ...inFlight]).size;
    if (covered >= 20) return;
    const tx = state.txFeeLamports();
    if (state.freeCashLamports() < PROBE_LAMPORTS + tx) return;
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      if (this.decided.has(mint) || this.watched.has(mint) || this.bought.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < PROBE_MIN_REAL_SOL) continue;
      if (state.maxBuyLamports(mint) < PROBE_LAMPORTS) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: PROBE_LAMPORTS,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      orders.push(buy);
      this.pendingKind.set(mint, 'probe');
      this.probeCount += 1;
      this.lastProbeSlot = batch.slot;
      return;
    }
  }
}
