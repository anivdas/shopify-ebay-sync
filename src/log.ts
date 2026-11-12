import { getSettings, run } from './db.ts';

export type Level = 'info' | 'warn' | 'error' | 'success';

export function logActivity(level: Level, type: string, message: string, data?: unknown) {
  run('INSERT INTO activity (level, type, message, data) VALUES (?, ?, ?, ?)', level, type, message, data === undefined ? null : JSON.stringify(data));
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${type}: ${message}`;
  (level === 'error' ? console.error : console.log)(line);
  if (level === 'error' || (level === 'warn' && type.startsWith('alert'))) void sendAlert(`${type}: ${message}`);
}

export async function sendAlert(text: string) {
  const url = getSettings().alertWebhookUrl;
  if (!url) return;
  try {
    const isNtfy = /ntfy/i.test(url);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': isNtfy ? 'text/plain' : 'application/json' },
      body: isNtfy ? `[Shopify-eBay Sync] ${text}` : JSON.stringify({ content: `[Shopify-eBay Sync] ${text}`, text: `[Shopify-eBay Sync] ${text}` }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error('Alert webhook failed', err);
  }
}

export function pruneActivity(days = 90) {
  run(`DELETE FROM activity WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`, `-${days} days`);
  run(`DELETE FROM market_snapshots WHERE taken_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', '-180 days')`);
}
