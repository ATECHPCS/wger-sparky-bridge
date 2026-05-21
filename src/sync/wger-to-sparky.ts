import { WgerClient, WgerMeasurement } from '../clients/wger.js';
import { SparkyClient, SparkyCustomCategory, SparkyExercise } from '../clients/sparky.js';
import { isSynced, markSynced } from '../db/state.js';

export interface Phase2Result {
  workouts: number;
  weight: number;
  measurements: number;
  errors: number;
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
  const result: Phase2Result = { workouts: 0, weight: 0, measurements: 0, errors: 0 };
  const exerciseCache: ExerciseCache = new Map();

  await syncWorkouts(wger, sparky, since, result, exerciseCache);
  await syncWeight(wger, sparky, since, result);
  await syncMeasurements(wger, sparky, since, result);

  return result;
}

async function syncWorkouts(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
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
        console.error(`[wger→sparky] failed to fetch logs for session ${session.id}:`, sanitize(err));
        result.errors++;
        continue;
      }

      let sessionErrors = 0;

      for (const log of logs) {
        const logKey = `log:${log.id}`;
        if (isSynced('wger', logKey, 'workout')) continue;

        try {
          const exerciseInfo = await wger.getExerciseInfo(log.exercise);
          if (!exerciseInfo) {
            console.warn(`[wger→sparky] exercise ${log.exercise} not found, skipping log ${log.id}`);
            sessionErrors++;
            continue;
          }

          const sparkyExercise = await resolveExercise(
            sparky,
            exerciseInfo.name,
            exerciseInfo.category,
            exerciseCache,
          );
          if (!sparkyExercise) {
            console.warn(`[wger→sparky] could not resolve Sparky exercise for "${exerciseInfo.name}", skipping log ${log.id}`);
            sessionErrors++;
            continue;
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
        } catch (err) {
          console.error(`[wger→sparky] workout log ${log.id} failed:`, sanitize(err));
          sessionErrors++;
          result.errors++;
        }
      }

      if (sessionErrors > 0) {
        console.warn(`[wger→sparky] session ${session.id} had ${sessionErrors} log error(s)`);
      }
    }
  } catch (err) {
    console.error('[wger→sparky] failed to fetch workout sessions:', sanitize(err));
    result.errors++;
  }
}

async function syncWeight(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
  result: Phase2Result,
): Promise<void> {
  try {
    const sinceStr = since.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const [wgerEntries, sparkyCheckIns] = await Promise.all([
      wger.getWeightEntries(since),
      sparky.getCheckInsRange(sinceStr, todayStr),
    ]);

    const sparkyDates = new Set(sparkyCheckIns.map((c) => c.entry_date));

    for (const entry of wgerEntries) {
      if (sparkyDates.has(entry.date)) continue;

      const weight = safeNumber(entry.weight, `weight entry ${entry.date}`);
      if (weight === null) { result.errors++; continue; }

      try {
        await sparky.upsertCheckIn({ entry_date: entry.date, weight });
        result.weight++;
      } catch (err) {
        console.error(`[wger→sparky] weight entry ${entry.date} failed:`, sanitize(err));
        result.errors++;
      }
    }
  } catch (err) {
    console.error('[wger→sparky] failed to sync weight:', sanitize(err));
    result.errors++;
  }
}

async function syncMeasurements(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
  result: Phase2Result,
): Promise<void> {
  try {
    const sinceStr = since.toISOString().slice(0, 10);
    const todayStr = new Date().toISOString().slice(0, 10);

    const [wgerCategories, sparkyCategories] = await Promise.all([
      wger.getMeasurementCategories(),
      sparky.getCustomCategories(),
    ]);

    const sparkyCategoryMap = buildSparkyCategoryMap(sparkyCategories);

    for (const wgerCategory of wgerCategories) {
      let sparkyCategoryId = sparkyCategoryMap.get(categoryKey(wgerCategory.name, wgerCategory.unit));

      if (sparkyCategoryId === undefined) {
        try {
          const created = await sparky.createCustomCategory(wgerCategory.name, wgerCategory.unit);
          if (!created.id) {
            console.error(`[wger→sparky] Sparky returned no id for category ${wgerCategory.name}`);
            result.errors++;
            continue;
          }
          sparkyCategoryId = created.id;
          sparkyCategoryMap.set(categoryKey(wgerCategory.name, wgerCategory.unit), sparkyCategoryId);
        } catch (err) {
          console.error(`[wger→sparky] failed to create category ${wgerCategory.name}:`, sanitize(err));
          result.errors++;
          continue;
        }
      }

      let wgerMeasurements: WgerMeasurement[];
      try {
        wgerMeasurements = await wger.getMeasurements(since, wgerCategory.id);
      } catch (err) {
        console.error(`[wger→sparky] failed to fetch measurements for category ${wgerCategory.id}:`, sanitize(err));
        result.errors++;
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
        if (value === null) { result.errors++; continue; }

        try {
          await sparky.upsertCustomEntry({
            category_id: sparkyCategoryId,
            date: mDate,
            value,
          });
          sparkyExisting.add(mDate);
          result.measurements++;
        } catch (err) {
          console.error(`[wger→sparky] measurement ${wgerCategory.name}/${mDate} failed:`, sanitize(err));
          result.errors++;
        }
      }
    }
  } catch (err) {
    console.error('[wger→sparky] failed to sync measurements:', sanitize(err));
    result.errors++;
  }
}

function categoryKey(name: string, unit: string): string {
  return `${name.toLowerCase()}|${unit.toLowerCase()}`;
}

function buildSparkyCategoryMap(categories: SparkyCustomCategory[]): Map<string, string> {
  return new Map(
    categories
      .filter((c): c is SparkyCustomCategory & { id: string } => typeof c.id === 'string')
      .map((c) => [categoryKey(c.name, c.measurement_type), c.id]),
  );
}
