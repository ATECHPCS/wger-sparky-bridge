import { WgerClient } from '../clients/wger.js';
import { SparkyClient } from '../clients/sparky.js';
import { getLastSyncTs, setLastSyncTs } from '../db/state.js';
import { sparkyToWger, Phase1Result } from './sparky-to-wger.js';
import { wgerToSparky, Phase2Result } from './wger-to-sparky.js';

export interface SyncResult {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  sparkyToWger: Phase1Result;
  wgerToSparky: Phase2Result;
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
  console.log(`[sync] phase1 done: weight=${phase1.weight} measurements=${phase1.measurements} errors=${phase1.errors}`);

  const phase2 = await wgerToSparky(wger, sparky, since);
  console.log(`[sync] phase2 done: workouts=${phase2.workouts} weight=${phase2.weight} measurements=${phase2.measurements} errors=${phase2.errors}`);

  const completedAt = new Date();
  const totalErrors = phase1.errors + phase2.errors;

  // Only advance the watermark when both phases completed without errors.
  // Failed records are older than the new watermark and would be skipped forever otherwise.
  const watermarkAdvanced = totalErrors === 0;
  if (watermarkAdvanced) {
    setLastSyncTs(completedAt);
  } else {
    console.warn(`[sync] ${totalErrors} error(s) — watermark NOT advanced, will retry next run`);
  }

  lastResult = {
    startedAt,
    completedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    sparkyToWger: phase1,
    wgerToSparky: phase2,
    watermarkAdvanced,
  };

  console.log(`[sync] run complete in ${lastResult.durationMs}ms (watermark advanced: ${watermarkAdvanced})`);
  return lastResult;
}
