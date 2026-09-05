import { WgerClient, WgerMeasurement } from '../clients/wger.js';
import { SparkyClient, SparkyCustomCategory, SparkyExercise } from '../clients/sparky.js';
import { isSynced, markSynced } from '../db/state.js';
import { FailTracker, newFailTracker, noteFailure, noteSuccess } from './failures.js';

export interface Phase2Result extends FailTracker {
  workouts: number;
  weight: number;
  measurements: number;
}

function safeNumber(value: string | number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.warn(`[wger→sparky] invalid numeric value for ${label}: ${JSON.stringify(value)}`);
    return null;
  }
  return n;
}

function sanitize(err: unknown): string {
  return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
}

// Cache exercise lookups within a sync run to avoid redundant searches
type ExerciseCache = Map<string, SparkyExercise | null>;

async function resolveExercise(
  sparky: SparkyClient,
  name: string,
  category: string,
  cache: ExerciseCache,
): Promise<SparkyExercise | null> {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;

  let exercise = await sparky.searchExercise(name);
  if (!exercise) {
    try {
      exercise = await sparky.createExercise(name, category);
    } catch (err) {
      console.error(`[wger→sparky] failed to create exercise "${name}":`, sanitize(err));
      cache.set(key, null);
      return null;
    }
  }
  cache.set(key, exercise);
  return exercise;
}

export async function wgerToSparky(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
): Promise<Phase2Result> {
  const result: Phase2Result = { workouts: 0, weight: 0, measurements: 0, ...newFailTracker() };
  const exerciseCache: ExerciseCache = new Map();
  const sinceStr = since.toISOString().slice(0, 10);

  await syncWorkouts(wger, sparky, since, sinceStr, result, exerciseCache);
  await syncWeight(wger, sparky, since, sinceStr, result);
  await syncMeasurements(wger, sparky, since, sinceStr, result);

  return result;
}

async function syncWorkouts(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
  sinceStr: string,
  result: Phase2Result,
  exerciseCache: ExerciseCache,
): Promise<void> {
  try {
    const sessions = await wger.getWorkoutSessions(since);

    for (const session of sessions) {
      let logs;
      try {
        logs = await wger.getWorkoutLogs(session.id);
      } catch (err) {
        noteFailure(result, `w2s:logs:${session.id}`, session.date, err);
        continue;
      }

      for (const log of logs) {
        const logKey = `log:${log.id}`;
        if (isSynced('wger', logKey, 'workout')) continue;

        try {
          const exerciseInfo = await wger.getExerciseInfo(log.exercise);
          if (!exerciseInfo) {
            console.warn(`[wger→sparky] exercise ${log.exercise} not found, skipping log ${log.id}`);
            continue; // unmappable data -> soft skip, does not hold the watermark
          }

          const sparkyExercise = await resolveExercise(
            sparky,
            exerciseInfo.name,
            exerciseInfo.category,
            exerciseCache,
          );
          if (!sparkyExercise) {
            console.warn(`[wger→sparky] could not resolve Sparky exercise for "${exerciseInfo.name}", skipping log ${log.id}`);
            continue; // unmappable data -> soft skip
          }

          const weight = safeNumber(log.weight, `log ${log.id} weight`);

          await sparky.createExerciseEntry({
            exercise_id: sparkyExercise.id,
            entry_date: session.date,
            sets: log.reps !== null || weight !== null
              ? [{ reps: log.reps ?? undefined, weight: weight ?? undefined }]
              : undefined,
            notes: session.notes || undefined,
          });

          markSynced('wger', logKey, 'workout');
          result.workouts++;
          noteSuccess(`w2s:log:${log.id}`);
        } catch (err) {
          noteFailure(result, `w2s:log:${log.id}`, session.date, err);
        }
      }
    }
  } catch (err) {
    noteFailure(result, 'w2s:fetch:sessions', sinceStr, err);
  }
}

async function syncWeight(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
  sinceStr: string,
  result: Phase2Result,
): Promise<void> {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);

    const [wgerEntries, sparkyCheckIns] = await Promise.all([
      wger.getWeightEntries(since),
      sparky.getCheckInsRange(sinceStr, todayStr),
    ]);

    const sparkyDates = new Set(sparkyCheckIns.map((c) => c.entry_date));

    for (const entry of wgerEntries) {
      if (sparkyDates.has(entry.date)) continue;

      const weight = safeNumber(entry.weight, `weight entry ${entry.date}`);
      if (weight === null) continue; // non-numeric -> skip, not an error

      const key = `w2s:weight:${entry.date}`;
      try {
        await sparky.upsertCheckIn({ entry_date: entry.date, weight });
        result.weight++;
        noteSuccess(key);
      } catch (err) {
        noteFailure(result, key, entry.date, err);
      }
    }
  } catch (err) {
    noteFailure(result, 'w2s:fetch:weight', sinceStr, err);
  }
}

async function syncMeasurements(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
  sinceStr: string,
  result: Phase2Result,
): Promise<void> {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);

    const [wgerCategories, sparkyCategories] = await Promise.all([
      wger.getMeasurementCategories(),
      sparky.getCustomCategories(),
    ]);

    const sparkyCategoryMap = buildSparkyCategoryMap(sparkyCategories);

    for (const wgerCategory of wgerCategories) {
      let sparkyCategoryId = sparkyCategoryMap.get(categoryKey(wgerCategory.name));

      if (sparkyCategoryId === undefined) {
        try {
          const created = await sparky.createCustomCategory(wgerCategory.name, wgerCategory.unit);
          if (!created.id) {
            noteFailure(result, `w2s:cat:${wgerCategory.name}`, sinceStr,
              new Error('Sparky returned no id for created category'));
            continue;
          }
          sparkyCategoryId = created.id;
          sparkyCategoryMap.set(categoryKey(wgerCategory.name), sparkyCategoryId);
        } catch (err) {
          noteFailure(result, `w2s:cat:${wgerCategory.name}`, sinceStr, err);
          continue;
        }
      }

      let wgerMeasurements: WgerMeasurement[];
      try {
        wgerMeasurements = await wger.getMeasurements(since, wgerCategory.id);
      } catch (err) {
        noteFailure(result, `w2s:meas-fetch:${wgerCategory.id}`, sinceStr, err);
        continue;
      }

      // Load existing Sparky entries for this category to prevent duplicates
      let sparkyExisting: Set<string>;
      try {
        const existing = await sparky.getCustomEntriesRange(sparkyCategoryId, sinceStr, todayStr);
        sparkyExisting = new Set(existing.map((e) => e.date.slice(0, 10)));
      } catch {
        sparkyExisting = new Set();
      }

      for (const m of wgerMeasurements) {
        const mDate = m.date.slice(0, 10); // normalize ISO datetime to YYYY-MM-DD
        if (sparkyExisting.has(mDate)) continue;

        const value = safeNumber(m.value, `measurement ${wgerCategory.name}/${mDate}`);
        if (value === null) continue; // non-numeric -> skip, not an error

        const key = `w2s:meas:${wgerCategory.name}:${mDate}`;
        try {
          await sparky.upsertCustomEntry({
            category_id: sparkyCategoryId,
            date: mDate,
            value,
          });
          sparkyExisting.add(mDate);
          result.measurements++;
          noteSuccess(key);
        } catch (err) {
          noteFailure(result, key, mDate, err);
        }
      }
    }
  } catch (err) {
    noteFailure(result, 'w2s:fetch:measurements', sinceStr, err);
  }
}

// Match categories by name only; units differ in formatting between wger and
// Sparky (e.g. 'lb' vs 'lbs'), which made name|unit miss existing categories
// and try to re-create duplicates (Sparky 400, e.g. "Body weight").
function categoryKey(name: string): string {
  return name.trim().toLowerCase();
}

function buildSparkyCategoryMap(categories: SparkyCustomCategory[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of categories) {
    if (typeof c.id !== 'string') continue;
    const k = categoryKey(c.name);
    if (!m.has(k)) m.set(k, c.id);
  }
  return m;
}
