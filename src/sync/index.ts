import { WgerClient } from '../clients/wger.js';
import { SparkyClient } from '../clients/sparky.js';
import { getLastSyncTs, setLastSyncTs } from '../db/state.js';
import { sparkyToWger, Phase1Result } from './sparky-to-wger.js';
import { wgerToSparky, Phase2Result } from './wger-to-sparky.js';
import { detectPRs } from '../pr/detect.js';

export interface SyncResult {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  sparkyToWger: Phase1Result;
  wgerToSparky: Phase2Result;
  prsDetected: number;
  watermarkAdvanced: boolean;
}

let lastResult: SyncResult | null = null;

export function getLastResult(): SyncResult | null {
  return lastResult;
}

export async function runSync(wger: WgerClient, sparky: SparkyClient): Promise<SyncResult> {
  const startedAt = new Date();
  const since = getLastSyncTs();

  console.log(`[sync] starting run, since=${since.toISOString()}`);

  const phase1 = await sparkyToWger(wger, sparky, since);
  console.log(`[sync] phase1 done: weight=${phase1.weight} measurements=${phase1.measurements} errors=${phase1.errors} dead=${phase1.dead}`);

  const phase2 = await wgerToSparky(wger, sparky, since);
  console.log(`[sync] phase2 done: workouts=${phase2.workouts} weight=${phase2.weight} measurements=${phase2.measurements} errors=${phase2.errors} dead=${phase2.dead}`);

  // PR detection is best-effort: it must never break the sync or the watermark.
  let prsDetected = 0;
  try {
    const pr = await detectPRs(wger, since);
    prsDetected = pr.detected;
    console.log(`[sync] pr detection done: detected=${prsDetected}`);
  } catch (err) {
    console.error('[sync] pr detection failed (ignored):', err instanceof Error ? err.message : String(err));
  }

  const completedAt = new Date();
  const totalErrors = phase1.errors + phase2.errors;

  // Advance the watermark to just before the OLDEST still-failing record, so
  // already-synced records are never reprocessed but the failing tail retries
  // next run. With no live failures, advance fully. Records that have exceeded
  // MAX_RETRIES are "dead" and do not hold the watermark back (permanently-bad
  // data can't wedge the sync into reprocessing the whole backlog forever).
  const earliestFailure = [phase1.earliestFailure, phase2.earliestFailure]
    .filter((d): d is string => d !== null)
    .sort()[0];

  let newWatermark: Date;
  if (earliestFailure) {
    const candidate = new Date(`${earliestFailure}T00:00:00.000Z`);
    // never move the watermark backwards
    newWatermark = candidate < since ? since : candidate;
    console.warn(`[sync] ${totalErrors} live error(s); watermark set to earliest unresolved failure ${earliestFailure}`);
  } else {
    newWatermark = completedAt;
  }
  const watermarkAdvanced = earliestFailure === undefined && newWatermark > since;
  setLastSyncTs(newWatermark);

  lastResult = {
    startedAt,
    completedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    sparkyToWger: phase1,
    wgerToSparky: phase2,
    prsDetected,
    watermarkAdvanced,
  };

  console.log(`[sync] run complete in ${lastResult.durationMs}ms (watermark advanced: ${watermarkAdvanced})`);
  return lastResult;
}
