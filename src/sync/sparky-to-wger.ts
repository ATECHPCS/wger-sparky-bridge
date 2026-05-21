import { WgerClient, WgerMeasurementCategory } from '../clients/wger.js';
import { SparkyClient } from '../clients/sparky.js';

export interface Phase1Result {
  weight: number;
  measurements: number;
  errors: number;
}

function safeNumber(value: unknown, label: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.warn(`[sparky→wger] invalid numeric value for ${label}: ${JSON.stringify(value)}`);
    return null;
  }
  return n;
}

export async function sparkyToWger(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
): Promise<Phase1Result> {
  const result: Phase1Result = { weight: 0, measurements: 0, errors: 0 };

  // Push weight check-ins from Sparky → wger (Sparky is master)
  try {
    const checkIns = await sparky.getWeightCheckIns(since);
    for (const checkIn of checkIns) {
      const weight = safeNumber(checkIn.weight, `weight ${checkIn.check_in_date}`);
      if (weight === null) {
        result.errors++;
        continue;
      }
      try {
        await wger.upsertWeightEntry(checkIn.check_in_date, weight);
        result.weight++;
      } catch (err) {
        console.error(`[sparky→wger] weight upsert failed for ${checkIn.check_in_date}:`, sanitize(err));
        result.errors++;
      }
    }
  } catch (err) {
    console.error('[sparky→wger] failed to fetch weight check-ins:', sanitize(err));
    result.errors++;
  }

  // Push custom measurements from Sparky → wger
  try {
    const [sparkyMeasurements, wgerCategories, sparkyCategories] = await Promise.all([
      sparky.getCustomMeasurements(since),
      wger.getMeasurementCategories(),
      sparky.getCustomCategories(),
    ]);

    const wgerCategoryMap = buildCategoryMap(wgerCategories);
    const sparkyCategoryMap = new Map(
      sparkyCategories
        .filter((c): c is typeof c & { id: number } => c.id !== undefined)
        .map((c) => [c.id, c]),
    );

    for (const m of sparkyMeasurements) {
      try {
        const sparkyCategory = sparkyCategoryMap.get(m.category_id);
        if (!sparkyCategory) {
          console.warn(`[sparky→wger] unknown Sparky category id ${m.category_id}, skipping`);
          continue;
        }

        const value = safeNumber(m.value, `measurement category ${m.category_id} on ${m.measurement_date}`);
        if (value === null) {
          result.errors++;
          continue;
        }

        const mapKey = categoryKey(sparkyCategory.name, sparkyCategory.unit);
        let wgerCategoryId = wgerCategoryMap.get(mapKey);
        if (wgerCategoryId === undefined) {
          const created = await wger.createMeasurementCategory(
            sparkyCategory.name,
            sparkyCategory.unit,
          );
          wgerCategoryId = created.id;
          wgerCategoryMap.set(mapKey, wgerCategoryId);
        }

        await wger.upsertMeasurement(wgerCategoryId, m.measurement_date, value);
        result.measurements++;
      } catch (err) {
        console.error(`[sparky→wger] measurement upsert failed for id ${m.id}:`, sanitize(err));
        result.errors++;
      }
    }
  } catch (err) {
    console.error('[sparky→wger] failed to sync measurements:', sanitize(err));
    result.errors++;
  }

  return result;
}

function categoryKey(name: string, unit: string): string {
  return `${name.toLowerCase()}|${unit.toLowerCase()}`;
}

function buildCategoryMap(categories: WgerMeasurementCategory[]): Map<string, number> {
  return new Map(categories.map((c) => [categoryKey(c.name, c.unit), c.id]));
}

function sanitize(err: unknown): string {
  if (err instanceof Error) return `${err.constructor.name}: ${err.message}`;
  return String(err);
}
