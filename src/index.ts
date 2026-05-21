import express from 'express';
import { WgerClient } from './clients/wger.js';
import { SparkyClient } from './clients/sparky.js';
import { startScheduler } from './scheduler.js';
import healthRouter from './routes/health.js';
import statusRouter from './routes/status.js';

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
const WGER_USERNAME = requireEnv('WGER_USERNAME');
const WGER_PASSWORD = requireEnv('WGER_PASSWORD');
const SPARKY_URL = requireEnv('SPARKY_URL');
const SPARKY_API_KEY = requireEnv('SPARKY_API_KEY');
const SPARKY_USER_ID = requireEnv('SPARKY_USER_ID');
const SYNC_CRON = process.env.SYNC_CRON ?? '0 * * * *';
const PORT = requirePort();

const wger = new WgerClient(WGER_URL, WGER_USERNAME, WGER_PASSWORD);
const sparky = new SparkyClient(SPARKY_URL, SPARKY_API_KEY, SPARKY_USER_ID);

const app = express();
app.use(express.json());
app.use(healthRouter);
app.use(statusRouter);

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  startScheduler(wger, sparky, SYNC_CRON);
  console.log(`[server] sync scheduler started (${SYNC_CRON})`);
});
