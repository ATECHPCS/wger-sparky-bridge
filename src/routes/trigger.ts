import { Router } from 'express';
import { WgerClient } from '../clients/wger.js';
import { SparkyClient } from '../clients/sparky.js';
import { runSync } from '../sync/index.js';

let running = false;

export function createTriggerRouter(wger: WgerClient, sparky: SparkyClient): Router {
  const router = Router();

  router.post('/sync/trigger', async (_req, res) => {
    if (running) {
      res.status(409).json({ error: 'sync already in progress' });
      return;
    }
    running = true;
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
      running = false;
    }
  });

  return router;
}
