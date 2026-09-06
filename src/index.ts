import express from 'express';
import { WgerClient } from './clients/wger.js';
import { SparkyClient } from './clients/sparky.js';
import { startScheduler, startDigestScheduler } from './scheduler.js';
import healthRouter from './routes/health.js';
import statusRouter from './routes/status.js';
import { createTriggerRouter } from './routes/trigger.js';
import { createDigestRouter } from './routes/digest.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function requirePort(): number {
  const raw = process.env.PORT ?? '3000';
  const port = parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }
  return port;
}

const WGER_URL = requireEnv('WGER_URL');
const WGER_API_TOKEN = requireEnv('WGER_API_TOKEN');
const SPARKY_URL = requireEnv('SPARKY_URL');
const SPARKY_API_KEY = requireEnv('SPARKY_API_KEY');
const SYNC_CRON = process.env.SYNC_CRON ?? '0 * * * *';
// Sun 18:05 — a few minutes past the top-of-hour sync so that run's PR
// detection has finished before the digest reads pr_event.
const DIGEST_CRON = process.env.DIGEST_CRON ?? '5 18 * * 0';
const PORT = requirePort();

const wger = new WgerClient(WGER_URL, WGER_API_TOKEN);
const sparky = new SparkyClient(SPARKY_URL, SPARKY_API_KEY);

const app = express();
app.use(express.json());
app.use(healthRouter);
app.use(statusRouter);
app.use(createTriggerRouter(wger, sparky));
app.use(createDigestRouter(wger));

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  try {
    startScheduler(wger, sparky, SYNC_CRON);
    console.log(`[server] sync scheduler started (${SYNC_CRON})`);
  } catch (err) {
    // A bad SYNC_CRON is a fatal misconfiguration (sync is the core job).
    console.error('[server] fatal:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  startDigestScheduler(wger, DIGEST_CRON); // non-fatal; logs and skips if invalid
  console.log(`[server] digest scheduler started (${DIGEST_CRON})`);
});
