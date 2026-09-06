import { Router } from 'express';
import { WgerClient } from '../clients/wger.js';
import { buildWeeklyDigest, sendWeeklyDigest } from '../digest/weekly.js';

export function createDigestRouter(wger: WgerClient): Router {
  const router = Router();

  // Preview the digest text without sending it.
  router.get('/digest/preview', async (_req, res) => {
    try {
      res.type('text/plain').send(await buildWeeklyDigest(wger));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Build and send the weekly digest to Telegram now.
  router.post('/digest/send', async (_req, res) => {
    try {
      const sent = await sendWeeklyDigest(wger);
      res.json({ ok: true, sent });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
