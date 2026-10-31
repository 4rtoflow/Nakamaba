import { describe, expect, it, vi } from 'vitest';
import { buildDiscordPayload, createDiscordNotifier } from '../../src/app/discord.ts';

const notice = { title: 'ページ', owner: 'alice', url: 'https://public.example.invalid/p/' };
const WEBHOOK = 'https://hooks.example.invalid/secret-token';

describe('buildDiscordPayload', () => {
  it('タイトル・公開した人・URL を載せる', () => {
    const { content } = buildDiscordPayload(notice);
    expect(content).toContain('ページ');
    expect(content).toContain('alice');
    expect(content).toContain(notice.url);
  });

  it('メンションを許可しない', () => {
    const payload = buildDiscordPayload({ ...notice, title: '@everyone 見て' });
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('タイトルの Markdown の記号をエスケープする', () => {
    const { content } = buildDiscordPayload({ ...notice, title: '**[罠](https://evil.example)**' });
    expect(content).toContain('\\*\\*\\[罠\\]\\(https://evil.example\\)\\*\\*');
  });
});

describe('createDiscordNotifier', () => {
  function setup(fetchImpl: typeof fetch, webhook: string | null = WEBHOOK) {
    const log = vi.fn();
    const notifier = createDiscordNotifier({
      getWebhookUrl: async () => webhook,
      fetch: fetchImpl,
      log,
    });
    return { log, notifier };
  }

  it('Webhook へ JSON を POST する', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const { notifier, log } = setup(fetchMock as unknown as typeof fetch);
    await notifier.notifyNewPage(notice);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).content).toContain(notice.url);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(log).not.toHaveBeenCalled();
  });

  it('Webhook が未設定なら送らずログに残す', async () => {
    const fetchMock = vi.fn();
    const { notifier, log } = setup(fetchMock as unknown as typeof fetch, null);
    await notifier.notifyNewPage(notice);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('discord_webhook_not_configured');
  });

  it('Discord が失敗を返しても例外にしない', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
    const { notifier, log } = setup(fetchMock as unknown as typeof fetch);
    await expect(notifier.notifyNewPage(notice)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('discord_notify_failed', { status: 500 });
  });

  it('通信に失敗しても例外にせず、ログに URL を残さない', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed ${WEBHOOK}`);
    });
    const { notifier, log } = setup(fetchMock as unknown as typeof fetch);
    await expect(notifier.notifyNewPage(notice)).resolves.toBeUndefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-token');
  });

  it('Webhook の読み取りに失敗しても例外にしない', async () => {
    const log = vi.fn();
    const notifier = createDiscordNotifier({
      getWebhookUrl: async () => {
        throw new Error('SSM に接続できません');
      },
      fetch: vi.fn() as unknown as typeof fetch,
      log,
    });
    await expect(notifier.notifyNewPage(notice)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });
});
