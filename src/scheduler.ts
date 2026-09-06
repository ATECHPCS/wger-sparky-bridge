import cron from 'node-cron';
import { WgerClient } from './clients/wger.js';
import { SparkyClient } from './clients/sparky.js';
import { runSync } from './sync/index.js';
import { tryAcquireRun, releaseRun } from './sync/lock.js';
import { sendWeeklyDigest } from './digest/weekly.js';
import { telegramEnabled } from './notify/telegram.js';

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
  // The weekly digest is an optional convenience: a bad DIGEST_CRON must not
  // take the whole bridge down, so log and skip rather than throw.
  if (!cron.validate(cronExpression)) {
    console.error(`[scheduler] invalid DIGEST_CRON "${cronExpression}"; weekly digest disabled`);
    return;
  }
  console.log(`[scheduler] digest cron: ${cronExpression}`);
  cron.schedule(cronExpression, async () => {
    try {
      const sent = await sendWeeklyDigest(wger);
      if (sent) console.log('[scheduler] weekly digest sent');
      else if (!telegramEnabled()) console.log('[scheduler] weekly digest skipped (Telegram off)');
      else console.warn('[scheduler] weekly digest send FAILED (Telegram error)');
    } catch (err) {
      console.error('[scheduler] digest error:', err instanceof Error ? err.message : String(err));
    }
  });
}
