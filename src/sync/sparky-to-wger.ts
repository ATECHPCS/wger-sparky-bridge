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

function sanitize(err: unknown): string {
  return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
}

export async function sparkyToWger(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
): Promise<Phase1Result> {
  const result: Phase1Result = { weight: 0, measurements: 0, errors: 0 };

  const sinceStr = since.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  // Push weight check-ins from Sparky → wger (Sparky is master)
  try {
    const checkIns = await sparky.getCheckInsRange(sinceStr, todayStr);
    for (const checkIn of checkIns) {
      if (checkIn.weight === undefined || checkIn.weight === null) continue;
      let weight = safeNumber(checkIn.weight, `weight ${checkIn.entry_date}`);
      if (weight === null) { result.errors++; continue; }
      // wger weight field is DecimalField(max_digits=5, decimal_places=2) — round to 2 dp
      weight = Math.round(weight * 100) / 100;
      try {
        await wger.upsertWeightEntry(checkIn.entry_date, weight);
        result.weight++;
      } catch (err) {
        console.error(`[sparky→wger] weight upsert failed for ${checkIn.entry_date}:`, sanitize(err));
        result.errors++;
      }
    }
  } catch (err) {
    console.error('[sparky→wger] failed to fetch weight check-ins:', sanitize(err));
    result.errors++;
  }

  // Push custom measurements from Sparky → wger
  try {
    const [wgerCategories, sparkyCategories] = await Promise.all([
      wger.getMeasurementCategories(),
      sparky.getCustomCategories(),
    ]);

    const wgerCategoryMap = buildWgerCategoryMap(wgerCategories);

    for (const sparkyCategory of sparkyCategories) {
      if (!sparkyCategory.id) continue;

      let wgerCategoryId = wgerCategoryMap.get(categoryKey(sparkyCategory.name));
      if (wgerCategoryId === undefined) {
        try {
          const created = await wger.createMeasurementCategory(sparkyCategory.name, sparkyCategory.measurement_type);
          wgerCategoryId = created.id;
          wgerCategoryMap.set(categoryKey(sparkyCategory.name), wgerCategoryId);
        } catch (err) {
          console.error(`[sparky→wger] failed to create category ${sparkyCategory.name}:`, sanitize(err));
          result.errors++;
          continue;
        }
      }

      let sparkyEntries;
      try {
        sparkyEntries = await sparky.getCustomEntriesRange(sparkyCategory.id, sinceStr, todayStr);
      } catch (err) {
        console.error(`[sparky→wger] failed to fetch entries for category ${sparkyCategory.name}:`, sanitize(err));
        result.errors++;
        continue;
      }

      for (const entry of sparkyEntries) {
        const entryDate = entry.date.slice(0, 10);
        const value = safeNumber(entry.value, `category ${sparkyCategory.name} on ${entryDate}`);
        if (value === null) { result.errors++; continue; }
        try {
          await wger.upsertMeasurement(wgerCategoryId, entryDate, value);
          result.measurements++;
        } catch (err) {
          console.error(`[sparky→wger] measurement upsert failed for ${sparkyCategory.name}/${entryDate}:`, sanitize(err));
          result.errors++;
        }
      }
    }
  } catch (err) {
    console.error('[sparky→wger] failed to sync measurements:', sanitize(err));
    result.errors++;
  }

  return result;
}

// Match categories by name only. Units are formatted differently between Sparky
// and wger (e.g. 'lbs' vs 'lb'), so keying on name|unit missed existing
// categories and tried to re-create duplicates (wger 400).
function categoryKey(name: string): string {
  return name.trim().toLowerCase();
}

function buildWgerCategoryMap(categories: WgerMeasurementCategory[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of categories) {
    const k = categoryKey(c.name);
    if (!m.has(k)) m.set(k, c.id);
  }
  return m;
}
