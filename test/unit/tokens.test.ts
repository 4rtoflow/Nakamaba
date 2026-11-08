import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../../src/app/deps.ts';
import { HttpError } from '../../src/app/http.ts';
import {
  generateToken,
  hashToken,
  issueToken,
  listTokens,
  revokeToken,
  revokeTokensOf,
  TOKEN_INACTIVE_DAYS,
  verifyToken,
} from '../../src/app/tokens.ts';
import { createFakeWorld, type FakeWorld } from '../support/fakes.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-11-01T03:00:00.000Z');

let world: FakeWorld;
let now: Date;
let alice: User;
let bob: User;
let root: User;

async function errorOf(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => {
      throw new Error('失敗するはずの処理が成功しました');
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

function later(days: number): void {
  now = new Date(START.getTime() + days * DAY_MS);
}

beforeEach(() => {
  now = START;
  world = createFakeWorld({ now: () => now });
  alice = world.addUser('alice');
  bob = world.addUser('bob');
  root = world.addUser('root', 'admin');
});

describe('generateToken', () => {
  it('nkmb_ に続けて 256 ビットの乱数を base64url で返し、毎回違う', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateToken()));
    expect(tokens.size).toBe(20);
    for (const token of tokens) expect(token).toMatch(/^nkmb_[A-Za-z0-9_-]{43}$/);
  });
});

describe('issueToken', () => {
  it('本物の値は応答だけで返し、表にはハッシュだけを残す', async () => {
    const issued = await issueToken(world.deps, alice, '  Bobert  ');
    expect(issued).toEqual({
      token: expect.stringMatching(/^nkmb_/),
      id: hashToken(issued.token).slice(0, 16),
      owner: 'alice',
      label: 'Bobert',
      createdAt: START.toISOString(),
      lastUsedAt: null,
      active: true,
    });
    const stored = [...world.tokens.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.hash).toBe(hashToken(issued.token));
    expect(JSON.stringify(stored)).not.toContain(issued.token);
  });

  it('50 文字までの名前を受け付ける（日本語も 1 文字と数える）', async () => {
    await expect(issueToken(world.deps, alice, 'あ'.repeat(50))).resolves.toMatchObject({
      label: 'あ'.repeat(50),
    });
  });

  it.each([
    ['空', ''],
    ['空白だけ', '   '],
    ['51 文字', 'あ'.repeat(51)],
    ['改行を含む', 'a\nb'],
    ['文字列でない', 42],
    ['無い', undefined],
  ])('名前が %s なら 400 にし、発行しない', async (_label, label) => {
    const error = await errorOf(issueToken(world.deps, alice, label));
    expect(error.status).toBe(400);
    expect(error.message).toBe('トークンの名前は、1〜50 文字で付けてください。');
    expect(world.tokens.size).toBe(0);
  });
});

describe('listTokens', () => {
  it('メンバーには自分のトークンだけを、新しい順に返し、ハッシュを含めない', async () => {
    await issueToken(world.deps, alice, '古い');
    later(1);
    await issueToken(world.deps, alice, '新しい');
    await issueToken(world.deps, bob, 'bob の');
    const tokens = await listTokens(world.deps, alice);
    expect(tokens.map((token) => token.label)).toEqual(['新しい', '古い']);
    expect(JSON.stringify(tokens)).not.toContain('hash');
  });

  it('Admin には全員のトークンを返す', async () => {
    await issueToken(world.deps, alice, 'alice の');
    await issueToken(world.deps, bob, 'bob の');
    const owners = (await listTokens(world.deps, root)).map((token) => token.owner);
    expect(owners.sort()).toEqual(['alice', 'bob']);
  });

  it(`${TOKEN_INACTIVE_DAYS} 日使われなかったトークンは active を false にする`, async () => {
    await issueToken(world.deps, alice, 'Bobert');
    later(TOKEN_INACTIVE_DAYS);
    expect((await listTokens(world.deps, alice))[0]?.active).toBe(false);
  });
});

describe('revokeToken', () => {
  it('本人は取り消せる', async () => {
    const { id } = await issueToken(world.deps, alice, 'Bobert');
    await revokeToken(world.deps, alice, id);
    expect(world.tokens.size).toBe(0);
  });

  it('Admin はほかの人のトークンも取り消せる', async () => {
    const { id } = await issueToken(world.deps, alice, 'Bobert');
    await revokeToken(world.deps, root, id);
    expect(world.tokens.size).toBe(0);
  });

  it('ほかのメンバーのトークンは、無いときと同じ 404 にして消さない', async () => {
    const { id } = await issueToken(world.deps, alice, 'Bobert');
    const error = await errorOf(revokeToken(world.deps, bob, id));
    expect(error.status).toBe(404);
    expect(error.message).toBe('トークンが見つかりません。');
    expect(world.tokens.size).toBe(1);
    expect((await errorOf(revokeToken(world.deps, bob, 'nothing'))).status).toBe(404);
  });

  it('ユーザーのトークンをまとめて取り消せる', async () => {
    await issueToken(world.deps, alice, '1');
    await issueToken(world.deps, alice, '2');
    await issueToken(world.deps, bob, 'bob の');
    await revokeTokensOf(world.deps, 'alice');
    expect([...world.tokens.values()].map((token) => token.owner)).toEqual(['bob']);
  });
});

describe('verifyToken', () => {
  it('取り消したトークンは通さない', async () => {
    const issued = await issueToken(world.deps, alice, 'Bobert');
    await revokeToken(world.deps, alice, issued.id);
    await expect(verifyToken(world.deps, issued.token)).resolves.toBeNull();
  });

  it('最後に使った日時は、1 日に 1 回まで書く', async () => {
    const { token } = await issueToken(world.deps, alice, 'Bobert');
    const stored = () => world.tokens.get(hashToken(token));

    await verifyToken(world.deps, token);
    expect(stored()?.lastUsedAt).toBe(START.toISOString());

    later(0.5);
    await verifyToken(world.deps, token);
    expect(stored()?.lastUsedAt).toBe(START.toISOString());

    later(1);
    await verifyToken(world.deps, token);
    expect(stored()?.lastUsedAt).toBe(now.toISOString());
  });

  it(`一度も使わなければ、発行から ${TOKEN_INACTIVE_DAYS} 日で使えなくなる`, async () => {
    const { token } = await issueToken(world.deps, alice, 'Bobert');
    later(TOKEN_INACTIVE_DAYS - 1);
    expect(await verifyToken(world.deps, token)).not.toBeNull();

    const { token: unused } = await issueToken(world.deps, alice, '使わない');
    later(TOKEN_INACTIVE_DAYS - 1 + TOKEN_INACTIVE_DAYS);
    await expect(verifyToken(world.deps, unused)).resolves.toBeNull();
  });

  it(`使い続けていれば期限は来ず、最後に使ってから ${TOKEN_INACTIVE_DAYS} 日で使えなくなる`, async () => {
    const { token } = await issueToken(world.deps, alice, 'Bobert');
    for (let day = 60; day <= 300; day += 60) {
      later(day);
      expect(await verifyToken(world.deps, token)).not.toBeNull();
    }
    later(300 + TOKEN_INACTIVE_DAYS);
    await expect(verifyToken(world.deps, token)).resolves.toBeNull();
  });
});
