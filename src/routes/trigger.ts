import { Router } from 'express';
import { WgerClient } from '../clients/wger.js';
import { SparkyClient } from '../clients/sparky.js';
import { runSync } from '../sync/index.js';
import { tryAcquireRun, releaseRun } from '../sync/lock.js';

export function createTriggerRouter(wger: WgerClient, sparky: SparkyClient): Router {
  const router = Router();

  router.post('/sync/trigger', async (_req, res) => {
    // Shared lock with the scheduler: never run two syncs at once.
    if (!tryAcquireRun()) {
      res.status(409).json({ error: 'sync already in progress' });
      return;
    }
    try {
      const result = await runSync(wger, sparky);
      res.json({
        ok: true,
        duration_ms: result.durationMs,
        watermark_advanced: result.watermarkAdvanced,
        sparky_to_wger: result.sparkyToWger,
        wger_to_sparky: result.wgerToSparky,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      releaseRun();
    }
  });

  return router;
}
