# makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yuyan5319-crypto/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/yuyan5319-crypto/makefun-u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Clean Curve Rider — a Sharpe-first paper-trading bot for the Pump.fun Sharpe Sprint
("Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins"). It trades paper SOL on a 6-hour
pump.fun bonding-curve replay; the highest hourly Sharpe ratio wins, so the bot optimises
for steady, positive-expectancy trades instead of one lucky moonshot.

## Strategy

Measured on the kit's 24h dev window (128,058 events, 1,222 coins), with the harness's
real 2-slot fill latency applied on both legs of every simulated trade:

- Short-window momentum (buy a +5% rise in 25 slots, tight stops) is negative expectancy
  at every take-profit / stop-loss in the grid (about −2.5% per trade after the 2.5%
  round-trip fee): after a fast rise the coin usually fades, and slot-level noise chops
  tight stops.
- Buying the first time a curve's real reserves cross 25 SOL looks like +0.46 per unit
  staked per trade if you ignore latency — and −0.10 once the 2-slot fill lag is
  included: the crossing is usually one big buy, and the fill lands on the spike's top.
- The level itself is real: coins that reach 25 SOL of real reserves often go on to
  complete (46% of the ones reaching 40 SOL migrate at ~85 SOL), and the bonding curve
  pays roughly +60–100% from 25 SOL to completion, while the downside is floored because
  a curve's price rarely falls back below its creation level. The edge survives only
  when the entry waits out the spike instead of chasing it.

So the bot buys one kind of coin, once, and only after it proves the level:

- **Watch** — the first trade on which a curve's real SOL reserves reach 25 SOL.
  Ignore the coin if that crossing trade was 2 SOL or more (one whale spike, not a
  level being built).
- **Entry** — 30 slots later, and only if the curve still holds ≥25 SOL of real reserves
  and its price is at or above the crossing price. One entry per coin, ever. Stake
  0.25 SOL (the 1%-of-real-reserve buy cap allows at most 0.25 SOL at 25 SOL of
  reserves). At most 5 open positions, at most 1.25 SOL of cost exposure at once.
- **Exit** — a trailing stop of 20% from the position's peak value, armed once the peak
  is up 10% on cost; or a 300-slot (~2 minute) time limit at market. No fixed
  take-profit and no fixed stop-loss: slot-level noise is several percent per trade, so
  tight price stops only donate to it. A curve that completes is closed by the replay at
  its final reserves — that is the payoff this bot is built to catch.
- **Guardrails** — tiny 0.02 SOL probe round trips keep the run above the 20-coin /
  0.01 SOL round-trip minimum whenever fills or coins lag the pace (this selective rule
  only fires ~8 times in a 6-hour window). Probes are paced at most one per 5,000 slots
  and at most 14 per run, and stop entirely once 20 distinct round-tripped mints are
  covered.

Everything is deterministic: no clock, no environment, no randomness — the two grading
runs produce byte-identical action logs.

## Dev-window measurements

Fresh post-open rebuild, graded with the kit's own grader
(`grade-local --driver process`, two executions, action logs reproduced byte
for byte):

- Net PnL **+0.3927 SOL** (return +3.93%, 90% interval −0.789 .. +1.751 SOL);
  at 2x fees still +0.1945 SOL.
- 82 fills over 41 coins, 41 round trips, win rate 31.7%, max drawdown 9.5%.
- Guardrails met: 41 coins hold a round trip of at least 0.01 SOL, drawdown
  under the 50% cap; 0 rejected orders, 3 failed transactions.
- Concentration note: the 3 best coins made 48% of the gains; without them net
  PnL would be −0.51 SOL — the dev score leans on a few completions, as the
  strategy intends (the completion payoff is the edge).

## Layout

- `main.ts` — entrypoint: runs the strategy through the replay shim.
- `strategy.ts` — the strategy (entry signal, exits, sizing, probes).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored byte for byte.

## Run it

Requires Node 22.18+ (the grader runs Node 22.23.4). From the competition kit directory,
grade this bot on the dev window with the kit's own grader (no docker needed):

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process
```

## License

MIT — see [LICENSE](LICENSE).
