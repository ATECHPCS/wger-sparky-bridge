import cron from 'node-cron';
import { WgerClient } from './clients/wger.js';
import { SparkyClient } from './clients/sparky.js';
import { runSync } from './sync/index.js';

let running = false;

export function startScheduler(
  wger: WgerClient,
  sparky: SparkyClient,
  cronExpression: string,
): void {
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid SYNC_CRON expression: ${cronExpression}`);
  }

  console.log(`[scheduler] cron: ${cronExpression}`);

  cron.schedule(cronExpression, async () => {
    if (running) {
      console.log('[scheduler] previous run still in progress, skipping');
      return;
    }
    running = true;
    try {
      await runSync(wger, sparky);
    } catch (err) {
      if (err instanceof Error) {
        console.error('[scheduler] unhandled sync error:', err.message);
      } else {
        console.error('[scheduler] unhandled sync error:', String(err));
      }
    } finally {
      running = false;
    }
  });
}
