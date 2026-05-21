import { Router } from 'express';
import { getLastResult } from '../sync/index.js';

const router = Router();

router.get('/sync/status', (_req, res) => {
  const last = getLastResult();

  if (!last) {
    res.json({ last_run: null, next_run: null });
    return;
  }

  res.json({
    last_run: last.startedAt.toISOString(),
    last_run_duration_ms: last.durationMs,
    next_run: null,
    watermark_advanced: last.watermarkAdvanced,
    last_run_result: {
      sparky_to_wger: {
        weight: last.sparkyToWger.weight,
        measurements: last.sparkyToWger.measurements,
        errors: last.sparkyToWger.errors,
      },
      wger_to_sparky: {
        workouts: last.wgerToSparky.workouts,
        weight: last.wgerToSparky.weight,
        measurements: last.wgerToSparky.measurements,
        errors: last.wgerToSparky.errors,
      },
    },
  });
});

export default router;
