import { WgerClient, WgerMeasurementCategory } from '../clients/wger.js';
import { SparkyClient } from '../clients/sparky.js';
import { FailTracker, newFailTracker, noteFailure, noteSoftFailure, noteSuccess } from './failures.js';

export interface Phase1Result extends FailTracker {
  weight: number;
  measurements: number;
}

// Sparky categories whose values are not scalar numbers (e.g. JSON time-series)
// cannot be wger measurements; skip them entirely.
const NON_NUMERIC_UNITS = new Set(['json']);

// Body weight is synced via the dedicated weight-checkin path, not as a custom
// measurement category (creating it as one is redundant and 400s on Sparky).
const WEIGHT_CATEGORY_NAMES = new Set(['body weight', 'weight', 'bodyweight']);

// Optional allowlist: when MEASUREMENT_ALLOWLIST is set (comma-separated category
// names), ONLY those Sparky categories are pushed into wger. This keeps the flood
// of Garmin/Apple micro-metrics (Body Battery, gait, stress, ...) out of wger -
// they crash the wger app's PowerSync load and are noise for a lifting app.
const MEASUREMENT_ALLOWLIST = new Set(
  (process.env.MEASUREMENT_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

function safeNumber(value: unknown, label: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    // Truncate: some non-numeric values are large JSON blobs.
    const preview = JSON.stringify(value).slice(0, 80);
    console.warn(`[sparky→wger] non-numeric value for ${label}, skipping: ${preview}`);
    return null;
  }
  return n;
}

export async function sparkyToWger(
  wger: WgerClient,
  sparky: SparkyClient,
  since: Date,
): Promise<Phase1Result> {
  const result: Phase1Result = { weight: 0, measurements: 0, ...newFailTracker() };

  const sinceStr = since.toISOString().slice(0, 10);
  const todayStr = new Date().toISOString().slice(0, 10);

  // Push weight check-ins from Sparky → wger (Sparky is master)
  try {
    const checkIns = await sparky.getCheckInsRange(sinceStr, todayStr);
    for (const checkIn of checkIns) {
      if (checkIn.weight === undefined || checkIn.weight === null) continue;
      let weight = safeNumber(checkIn.weight, `weight ${checkIn.entry_date}`);
      if (weight === null) continue; // non-numeric -> skip, not an error
      // wger weight field is DecimalField(max_digits=5, decimal_places=2) — round to 2 dp
      weight = Math.round(weight * 100) / 100;
      const key = `s2w:weight:${checkIn.entry_date}`;
      try {
        await wger.upsertWeightEntry(checkIn.entry_date, weight);
        result.weight++;
        noteSuccess(key);
      } catch (err) {
        noteFailure(result, key, checkIn.entry_date, err);
      }
    }
  } catch (err) {
    noteFailure(result, 's2w:fetch:checkins', sinceStr, err);
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
      if (NON_NUMERIC_UNITS.has((sparkyCategory.measurement_type || '').toLowerCase())) continue;
      if (WEIGHT_CATEGORY_NAMES.has(categoryKey(sparkyCategory.name))) continue;
      if (MEASUREMENT_ALLOWLIST.size > 0 && !MEASUREMENT_ALLOWLIST.has(categoryKey(sparkyCategory.name))) continue;

      let wgerCategoryId = wgerCategoryMap.get(categoryKey(sparkyCategory.name));
      if (wgerCategoryId === undefined) {
        try {
          const created = await wger.createMeasurementCategory(sparkyCategory.name, sparkyCategory.measurement_type);
          wgerCategoryId = created.id;
          wgerCategoryMap.set(categoryKey(sparkyCategory.name), wgerCategoryId);
        } catch (err) {
          noteSoftFailure(result, `s2w:cat:${sparkyCategory.name}`, err);
          continue;
        }
      }

      let sparkyEntries;
      try {
        sparkyEntries = await sparky.getCustomEntriesRange(sparkyCategory.id, sinceStr, todayStr);
      } catch (err) {
        noteSoftFailure(result, `s2w:entries:${sparkyCategory.name}`, err);
        continue;
      }

      for (const entry of sparkyEntries) {
        const entryDate = entry.date.slice(0, 10);
        const value = safeNumber(entry.value, `category ${sparkyCategory.name} on ${entryDate}`);
        if (value === null) continue; // non-numeric -> skip, not an error
        const key = `s2w:meas:${sparkyCategory.name}:${entryDate}`;
        try {
          await wger.upsertMeasurement(wgerCategoryId, entryDate, value);
          result.measurements++;
          noteSuccess(key);
        } catch (err) {
          noteFailure(result, key, entryDate, err);
        }
      }
    }
  } catch (err) {
    noteFailure(result, 's2w:fetch:categories', sinceStr, err);
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
