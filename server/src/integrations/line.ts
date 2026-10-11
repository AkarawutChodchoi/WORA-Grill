import type { Config } from '../config';

/**
 * LINE Messaging API push (staff alerts). Disabled unless both the channel token and a target id are
 * configured. Customer marketing via LINE is NOT sent from here — it needs consent flows (Prompt 12).
 */
export interface LineNotifier {
  enabled: boolean;
  push(text: string): Promise<boolean>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export function createLineNotifier(config: Pick<Config, 'LINE_CHANNEL_ACCESS_TOKEN' | 'LINE_NOTIFY_TO'>, fetchImpl: FetchLike = fetch as unknown as FetchLike, log: (msg: string) => void = () => undefined): LineNotifier {
  const token = config.LINE_CHANNEL_ACCESS_TOKEN;
  const to = config.LINE_NOTIFY_TO;
  return {
    enabled: !!(token && to),
    async push(text) {
      if (!token || !to) return false;
      try {
        const res = await fetchImpl('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
        });
        if (!res.ok) log(`LINE push failed with HTTP ${res.status}`);
        return res.ok;
      } catch (e) {
        log(`LINE push error: ${(e as Error).message}`);
        return false;
      }
    },
  };
}
