import { WgerClient } from '../clients/wger.js';
import { getRecentPrEvents } from '../db/state.js';
import { sendTelegram, telegramEnabled } from '../notify/telegram.js';
import { KG_TO_LB_ENABLED } from '../sync/sparky-to-wger.js';

const DAY = 24 * 60 * 60 * 1000;
const UNIT = KG_TO_LB_ENABLED ? 'lb' : 'kg';

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY);
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Entry whose date is closest to `target`, from date-sorted entries. */
function nearest(entries: { date: string; weight: string }[], target: string): number | null {
  if (entries.length === 0) return null;
  let best: { diff: number; w: number } | null = null;
  const t = new Date(target).getTime();
  for (const e of entries) {
    const w = Number(e.weight);
    if (!Number.isFinite(w)) continue;
    const diff = Math.abs(new Date(e.date).getTime() - t);
    if (best === null || diff < best.diff) best = { diff, w };
  }
  return best?.w ?? null;
}

function fmtDelta(delta: number): string {
  const s = delta > 0 ? '+' : '';
  return `${s}${delta.toFixed(1)} ${UNIT}`;
}

export async function buildWeeklyDigest(wger: WgerClient): Promise<string> {
  const lines: string[] = ['📊 <b>Weekly fitness digest</b>', ''];

  // Weight trend --------------------------------------------------------
  try {
    const entries = (await wger.getWeightEntries(daysAgo(35))).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    if (entries.length > 0) {
      const latest = Number(entries[entries.length - 1].weight);
      const w7 = nearest(entries, iso(daysAgo(7)));
      const w30 = nearest(entries, iso(daysAgo(30)));
      lines.push(`⚖️ Weight: <b>${latest.toFixed(1)} ${UNIT}</b>`);
      if (w7 !== null) lines.push(`   7-day: ${fmtDelta(latest - w7)}`);
      if (w30 !== null) lines.push(`   30-day: ${fmtDelta(latest - w30)}`);
    } else {
      lines.push('⚖️ Weight: no entries in the last 35 days');
    }
  } catch (err) {
    lines.push('⚖️ Weight: unavailable');
    console.warn('[digest] weight section failed:', String(err));
  }
  lines.push('');

  // Training ------------------------------------------------------------
  try {
    const sessions = await wger.getWorkoutSessions(daysAgo(30));
    const in7 = new Set<string>();
    let count30 = 0;
    const cut7 = iso(daysAgo(7));
    for (const s of sessions) {
      const d = s.date.slice(0, 10);
      count30++;
      if (d >= cut7) in7.add(d);
    }
    lines.push(`🏋️ Trained <b>${in7.size}</b> of the last 7 days`);
    lines.push(`   ${count30} sessions in the last 30 days`);
  } catch (err) {
    lines.push('🏋️ Training: unavailable');
    console.warn('[digest] training section failed:', String(err));
  }
  lines.push('');

  // PRs -----------------------------------------------------------------
  const prs = getRecentPrEvents(iso(daysAgo(7)));
  if (prs.length > 0) {
    lines.push(`🏆 <b>${prs.length} new PR${prs.length > 1 ? 's' : ''} this week</b>`);
    for (const p of prs.slice(0, 5)) {
      lines.push(`   ${p.exercise_name}: ${p.weight} × ${p.reps} (1RM ${Math.round(p.est_1rm)})`);
    }
  } else {
    lines.push('🏆 No new PRs this week');
  }

  return lines.join('\n');
}

export async function sendWeeklyDigest(wger: WgerClient): Promise<boolean> {
  if (!telegramEnabled()) {
    console.warn('[digest] Telegram not configured; skipping weekly digest');
    return false;
  }
  const text = await buildWeeklyDigest(wger);
  return sendTelegram(text);
}
