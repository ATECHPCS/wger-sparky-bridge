import { WgerClient } from '../clients/wger.js';
import { isSynced, markSynced, getPrBest, setPrBest, recordPrEvent } from '../db/state.js';
import { sendTelegram } from '../notify/telegram.js';

// Epley estimated one-rep max: weight * (1 + reps/30). Lets us compare sets of
// different rep counts on one scale, so a heavier-but-fewer-reps set counts.
export function estimate1RM(weight: number, reps: number): number {
  return weight * (1 + reps / 30);
}

// A new best must beat the old by at least this fraction to count as a PR
// (filters noise from tiny plate/rounding differences).
const MIN_IMPROVEMENT = Number(process.env.PR_MIN_IMPROVEMENT ?? 0.005);
// Only push a Telegram nudge for PRs dated within this many days, so seeding
// bests from historical logs on first run doesn't spam old "PRs".
const ALERT_DAYS = Number(process.env.PR_ALERT_DAYS ?? 3);

export interface PrDetectResult {
  detected: number;
}

export async function detectPRs(wger: WgerClient, since: Date): Promise<PrDetectResult> {
  const result: PrDetectResult = { detected: 0 };
  const nameCache = new Map<number, string>();
  const alertCutoff = new Date(Date.now() - ALERT_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  let sessions;
  try {
    sessions = await wger.getWorkoutSessions(since);
  } catch (err) {
    console.warn('[pr] could not fetch sessions:', String(err));
    return result;
  }

  for (const session of sessions) {
    let logs;
    try {
      logs = await wger.getWorkoutLogs(session.id);
    } catch (err) {
      console.warn(`[pr] could not fetch logs for session ${session.id}:`, String(err));
      continue;
    }

    for (const log of logs) {
      const dedupKey = `log:${log.id}`;
      if (isSynced('wger', dedupKey, 'pr')) continue;

      const weight = Number(log.weight);
      const reps = Number(log.reps);
      // Only strength sets with both a load and reps are PR-comparable.
      if (!(Number.isFinite(weight) && weight > 0 && Number.isFinite(reps) && reps >= 1)) {
        markSynced('wger', dedupKey, 'pr');
        continue;
      }

      const oneRm = estimate1RM(weight, reps);
      const best = getPrBest(log.exercise);
      const date = session.date.slice(0, 10);

      if (!best) {
        // First time we've seen this exercise: seed the baseline, no alert.
        setPrBest({ exercise_id: log.exercise, best_1rm: oneRm, best_weight: weight, best_reps: reps, date });
        markSynced('wger', dedupKey, 'pr');
        continue;
      }

      if (oneRm > best.best_1rm * (1 + MIN_IMPROVEMENT)) {
        let name = nameCache.get(log.exercise);
        if (name === undefined) {
          const info = await wger.getExerciseInfo(log.exercise);
          name = info?.name ?? `Exercise ${log.exercise}`;
          nameCache.set(log.exercise, name);
        }
        recordPrEvent({
          exercise_id: log.exercise,
          exercise_name: name,
          weight,
          reps,
          est_1rm: Math.round(oneRm * 10) / 10,
          prev_1rm: Math.round(best.best_1rm * 10) / 10,
          date,
        });
        setPrBest({ exercise_id: log.exercise, best_1rm: oneRm, best_weight: weight, best_reps: reps, date });
        result.detected++;

        if (date >= alertCutoff) {
          await sendTelegram(
            `🏆 <b>New PR: ${name}</b>\n${weight} × ${reps} (est. 1RM ${Math.round(oneRm)})\nPrevious best est. 1RM: ${Math.round(best.best_1rm)}\nDate: ${date}`,
          );
        }
      }

      markSynced('wger', dedupKey, 'pr');
    }
  }

  return result;
}
