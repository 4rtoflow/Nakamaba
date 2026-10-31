import type { NewPageNotice, Notifier } from './deps.ts';

const TIMEOUT_MS = 3000;

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|>#[\]()-]/g, '\\$&');
}

export function buildDiscordPayload(notice: NewPageNotice): {
  content: string;
  allowed_mentions: { parse: never[] };
} {
  return {
    content: [
      '新しいページが公開されました',
      `**${escapeMarkdown(notice.title)}**（公開した人: ${escapeMarkdown(notice.owner)}）`,
      notice.url,
    ].join('\n'),
    // タイトルは他の人が決めるので、@everyone などで全員に通知できないようにする
    allowed_mentions: { parse: [] },
  };
}

export function createDiscordNotifier(options: {
  getWebhookUrl: () => Promise<string | null>;
  fetch: typeof fetch;
  log: (message: string, detail?: unknown) => void;
}): Notifier {
  return {
    /** ページはもう公開できているので、失敗しても例外にせずログだけ残す */
    async notifyNewPage(notice) {
      try {
        const url = await options.getWebhookUrl();
        if (!url) {
          options.log('discord_webhook_not_configured');
          return;
        }
        const response = await options.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildDiscordPayload(notice)),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          options.log('discord_notify_failed', { status: response.status });
        }
      } catch (error) {
        // Webhook の URL が混ざらないよう、例外の名前だけを残す
        options.log('discord_notify_failed', { error: (error as Error).name });
      }
    },
  };
}
