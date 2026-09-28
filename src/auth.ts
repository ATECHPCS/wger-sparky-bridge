import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

// Guards every route mounted after it. Fails closed: with no BRIDGE_API_KEY
// configured the protected routes refuse all requests instead of running open.
export function requireApiKey(apiKey: string | undefined): RequestHandler {
  const expected = apiKey ? Buffer.from(apiKey) : null;
  return (req, res, next) => {
    if (!expected) {
      res.status(503).json({ error: 'BRIDGE_API_KEY not configured' });
      return;
    }
    const given = Buffer.from(req.get('X-API-Key') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
