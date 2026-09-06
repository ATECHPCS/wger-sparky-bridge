import axios from 'axios';

// Optional Telegram notifications. No-op (returns false) unless both
// TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, so the bridge runs fine
// without them and never throws on a notify path.
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

export function telegramEnabled(): boolean {
  return BOT_TOKEN.length > 0 && CHAT_ID.length > 0;
}

/** Escape text interpolated into an HTML-parse-mode message. Without this a
 * value containing &, <, or > (e.g. an exercise name) makes Telegram reject
 * the whole message. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Send a Telegram message. Never throws — a notification failure must not
 * break a sync run. Returns true if the message was accepted.
 */
export async function sendTelegram(text: string): Promise<boolean> {
  if (!telegramEnabled()) return false;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true },
      { timeout: Number(process.env.REQUEST_TIMEOUT_MS ?? 30000) },
    );
    return true;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn(`[telegram] send failed: ${m}`);
    return false;
  }
}
