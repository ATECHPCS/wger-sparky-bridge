import { WgerClient, WgerMeasurement } from '../clients/wger.js';
import { SparkyClient, SparkyCustomCategory } from '../clients/sparky.js';
import { isSynced, markSynced } from '../db/state.js';

export interface Phase2Result {
  workouts: number;
  weight: number;
  measurements: number;
  errors: number;
}

export async function wgerToSparky(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
): Promise<Phase2Result> {
  const result: Phase2Result = { workouts: 0, weight: 0, measurements: 0, errors: 0 };

  await syncWorkouts(wger, sparky, since, result);
  await syncWeight(wger, sparky, since, result);
  await syncMeasurements(wger, sparky, since, result);

  return result;
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

async function syncWorkouts(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
  result: Phase2Result,
): Promise<void> {
  try {
    const sessions = await wger.getWorkoutSessions(since);

    for (const session of sessions) {
      let logs;
      try {
        logs = await wger.getWorkoutLogs(session.id);
      } catch (err) {
        console.error(`[wger→sparky] failed to fetch logs for session ${session.id}:`, err);
        result.errors++;
        continue;
      }

      let sessionErrors = 0;

      for (const log of logs) {
        // Deduplicate at the log level, not the session level
        const logKey = `log:${log.id}`;
        if (isSynced('wger', logKey, 'workout')) continue;

        try {
          const exercise = await wger.getExerciseInfo(log.exercise);
          if (!exercise) {
            console.warn(`[wger→sparky] exercise ${log.exercise} not found, skipping log ${log.id}`);
            sessionErrors++;
            continue;
          }

          const weight = safeNumber(log.weight, `log ${log.id} weight`);

          await sparky.createExerciseEntry({
            entry_date: session.date,
            exercise_name: exercise.name,
            reps: log.reps ?? undefined,
            weight: weight ?? undefined,
            notes: session.notes || undefined,
          });

          markSynced('wger', logKey, 'workout');
          result.workouts++;
        } catch (err) {
          console.error(`[wger→sparky] workout log ${log.id} failed:`, err);
          sessionErrors++;
          result.errors++;
        }
      }

      if (sessionErrors > 0) {
        console.warn(`[wger→sparky] session ${session.id} had ${sessionErrors} log error(s), not marking fully synced`);
      }
    }
  } catch (err) {
    console.error('[wger→sparky] failed to fetch workout sessions:', err);
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
    const [wgerEntries, sparkyCheckIns] = await Promise.all([
      wger.getWeightEntries(since),
      sparky.getWeightCheckIns(since),
    ]);

    const sparkyDates = new Set(sparkyCheckIns.map((c) => c.check_in_date));

    for (const entry of wgerEntries) {
      if (sparkyDates.has(entry.date)) continue;

      const weight = safeNumber(entry.weight, `weight entry ${entry.date}`);
      if (weight === null) {
        result.errors++;
        continue;
      }

      try {
        await sparky.createWeightCheckIn({ check_in_date: entry.date, weight });
        result.weight++;
      } catch (err) {
        console.error(`[wger→sparky] weight entry ${entry.date} failed:`, err);
        result.errors++;
      }
    }
  } catch (err) {
    console.error('[wger→sparky] failed to sync weight:', err);
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
    const [wgerCategories, sparkyCategories, sparkyMeasurements] = await Promise.all([
      wger.getMeasurementCategories(),
      sparky.getCustomCategories(),
      // Load all existing Sparky measurements to match against the full wger window
      sparky.getCustomMeasurements(since),
    ]);

    const sparkyCategoryMap = buildSparkyCategoryMap(sparkyCategories);
    const sparkyExisting = buildSparkyMeasurementSet(sparkyMeasurements);

    for (const wgerCategory of wgerCategories) {
      let sparkyCategoryId = sparkyCategoryMap.get(categoryKey(wgerCategory.name, wgerCategory.unit));

      if (sparkyCategoryId === undefined) {
        try {
          const created = await sparky.createCustomCategory({
            name: wgerCategory.name,
            unit: wgerCategory.unit,
          });
          if (created.id === undefined) {
            console.error(`[wger→sparky] Sparky returned no id for created category ${wgerCategory.name}`);
            result.errors++;
            continue;
          }
          sparkyCategoryId = created.id;
          sparkyCategoryMap.set(categoryKey(wgerCategory.name, wgerCategory.unit), sparkyCategoryId);
        } catch (err) {
          console.error(`[wger→sparky] failed to create category ${wgerCategory.name}:`, err);
          result.errors++;
          continue;
        }
      }

      let wgerMeasurements: WgerMeasurement[];
      try {
        wgerMeasurements = await wger.getMeasurements(since, wgerCategory.id);
      } catch (err) {
        console.error(`[wger→sparky] failed to fetch measurements for category ${wgerCategory.id}:`, err);
        result.errors++;
        continue;
      }

      for (const m of wgerMeasurements) {
        const key = `${sparkyCategoryId}:${m.date}`;
        if (sparkyExisting.has(key)) continue;

        const value = safeNumber(m.value, `measurement ${wgerCategory.name}/${m.date}`);
        if (value === null) {
          result.errors++;
          continue;
        }

        try {
          await sparky.createCustomMeasurement({
            measurement_date: m.date,
            category_id: sparkyCategoryId,
            value,
          });
          sparkyExisting.add(key); // prevent re-creation within same run
          result.measurements++;
        } catch (err) {
          console.error(`[wger→sparky] measurement ${wgerCategory.name}/${m.date} failed:`, err);
          result.errors++;
        }
      }
    }
  } catch (err) {
    console.error('[wger→sparky] failed to sync measurements:', err);
    result.errors++;
  }
}

function categoryKey(name: string, unit: string): string {
  return `${name.toLowerCase()}|${unit.toLowerCase()}`;
}

function buildSparkyCategoryMap(categories: SparkyCustomCategory[]): Map<string, number> {
  return new Map(
    categories
      .filter((c): c is SparkyCustomCategory & { id: number } => c.id !== undefined)
      .map((c) => [categoryKey(c.name, c.unit), c.id]),
  );
}

function buildSparkyMeasurementSet(
  measurements: { category_id: number; measurement_date: string }[],
): Set<string> {
  return new Set(measurements.map((m) => `${m.category_id}:${m.measurement_date}`));
}
