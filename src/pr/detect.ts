import { WgerClient } from '../clients/wger.js';
import {
  isSynced,
  markSynced,
  getPrBest,
  setPrBest,
  recordPrEvent,
  transaction,
  PrBest,
} from '../db/state.js';
import { sendTelegram, escapeHtml } from '../notify/telegram.js';

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

// One pending PR per exercise for this run: keeps only the best set seen and
// the pre-run baseline, so a session with several improving sets yields one
// event and one alert (not a burst), regardless of log ordering.
interface Pending {
  log_id: number;
  exercise_id: number;
  weight: number;
  reps: number;
  est_1rm: number;
  prev_1rm: number; // best BEFORE this run
  date: string;
}

export async function detectPRs(wger: WgerClient, since: Date): Promise<PrDetectResult> {
  const result: PrDetectResult = { detected: 0 };
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
  // Deterministic: oldest sessions first so baselines seed before improvements.
  sessions = [...sessions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  // Running best per exercise (seeded from DB, updated as we go) and the one
  // pending PR per exercise.
  const bestMap = new Map<number, PrBest>();
  const pending = new Map<number, Pending>();

  function currentBest(exerciseId: number): PrBest | undefined {
    if (bestMap.has(exerciseId)) return bestMap.get(exerciseId);
    const b = getPrBest(exerciseId);
    if (b) bestMap.set(exerciseId, b);
    return b;
  }

  for (const session of sessions) {
    let logs;
    try {
      logs = await wger.getWorkoutLogs(session.id);
    } catch (err) {
      console.warn(`[pr] could not fetch logs for session ${session.id}:`, String(err));
      continue;
    }
    logs = [...logs].sort((a, b) => a.id - b.id); // deterministic order
    const date = session.date.slice(0, 10);

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
      const best = currentBest(log.exercise);
      const newBest: PrBest = {
        exercise_id: log.exercise,
        best_1rm: oneRm,
        best_weight: weight,
        best_reps: reps,
        date,
      };

      if (!best) {
        // First time we've seen this exercise: seed the baseline, no alert.
        transaction(() => {
          setPrBest(newBest);
          markSynced('wger', dedupKey, 'pr');
        });
        bestMap.set(log.exercise, newBest);
        continue;
      }

      if (oneRm > best.best_1rm * (1 + MIN_IMPROVEMENT)) {
        // The pre-run baseline is the best of any exercise NOT yet improved
        // this run; once pending exists, keep its original prev_1rm.
        const prevOriginal = pending.get(log.exercise)?.prev_1rm ?? best.best_1rm;
        transaction(() => {
          setPrBest(newBest);
          markSynced('wger', dedupKey, 'pr');
        });
        bestMap.set(log.exercise, newBest);

        const prior = pending.get(log.exercise);
        if (!prior || oneRm > prior.est_1rm) {
          pending.set(log.exercise, {
            log_id: log.id,
            exercise_id: log.exercise,
            weight,
            reps,
            est_1rm: oneRm,
            prev_1rm: prevOriginal,
            date,
          });
        }
        continue;
      }

      // Comparable but not a PR — just mark it processed.
      markSynced('wger', dedupKey, 'pr');
    }
  }

  // One event + at most one alert per exercise.
  const nameCache = new Map<number, string>();
  for (const p of pending.values()) {
    let name = nameCache.get(p.exercise_id);
    if (name === undefined) {
      const info = await wger.getExerciseInfo(p.exercise_id);
      name = info?.name ?? `Exercise ${p.exercise_id}`;
      nameCache.set(p.exercise_id, name);
    }
    recordPrEvent({
      log_id: p.log_id,
      exercise_id: p.exercise_id,
      exercise_name: name,
      weight: p.weight,
      reps: p.reps,
      est_1rm: Math.round(p.est_1rm * 10) / 10,
      prev_1rm: Math.round(p.prev_1rm * 10) / 10,
      date: p.date,
    });
    result.detected++;

    if (p.date >= alertCutoff) {
      await sendTelegram(
        `🏆 <b>New PR: ${escapeHtml(name)}</b>\n${p.weight} × ${p.reps} (est. 1RM ${Math.round(p.est_1rm)})\nPrevious best est. 1RM: ${Math.round(p.prev_1rm)}\nDate: ${p.date}`,
      );
    }
  }

  return result;
}
