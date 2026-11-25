// Clean Curve Rider — entrypoint: runs the strategy through the replay shim.
import { runBot } from './vendor/makefun-bot.ts';
import { CurveRider } from './strategy.ts';

const rider = new CurveRider();

await runBot({
  onBatch(state, batch) {
    return rider.onBatch(state, batch);
  },
});
