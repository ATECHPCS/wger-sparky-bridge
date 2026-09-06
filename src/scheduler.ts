import cron from 'node-cron';
import { WgerClient } from './clients/wger.js';
import { SparkyClient } from './clients/sparky.js';
import { runSync } from './sync/index.js';
import { tryAcquireRun, releaseRun } from './sync/lock.js';
import { sendWeeklyDigest } from './digest/weekly.js';

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
    // Shared lock: skip if a scheduled OR manually-triggered run is in progress.
    if (!tryAcquireRun()) {
      console.log('[scheduler] previous run still in progress, skipping');
      return;
    }
    try {
      await runSync(wger, sparky);
    } catch (err) {
      if (err instanceof Error) {
        console.error('[scheduler] unhandled sync error:', err.message);
      } else {
        console.error('[scheduler] unhandled sync error:', String(err));
      }
    } finally {
      releaseRun();
    }
  });
}

export function startDigestScheduler(wger: WgerClient, cronExpression: string): void {
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid DIGEST_CRON expression: ${cronExpression}`);
  }
  console.log(`[scheduler] digest cron: ${cronExpression}`);
  cron.schedule(cronExpression, async () => {
    try {
      const sent = await sendWeeklyDigest(wger);
      console.log(`[scheduler] weekly digest ${sent ? 'sent' : 'skipped (Telegram off)'}`);
    } catch (err) {
      console.error('[scheduler] digest error:', err instanceof Error ? err.message : String(err));
    }
  });
}
