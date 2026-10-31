import { describe, expect, it } from 'vitest';
import { assertAdmin, authenticate, parseBasicAuth } from '../../src/app/auth.ts';
import { HttpError } from '../../src/app/http.ts';
import { basicHeader, createFakeWorld } from '../support/fakes.ts';

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('parseBasicAuth', () => {
  it('ユーザー名とパスワードを取り出す', () => {
    expect(parseBasicAuth(`Basic ${encode('alice:secret')}`)).toEqual({
      username: 'alice',
      password: 'secret',
    });
  });

  it('スキーム名の大文字小文字を区別しない', () => {
    expect(parseBasicAuth(`basic ${encode('alice:secret')}`)?.username).toBe('alice');
  });

  it('パスワードのコロンは最初の 1 つだけで区切る', () => {
    expect(parseBasicAuth(`Basic ${encode('alice:a:b:c')}`)?.password).toBe('a:b:c');
  });

  it.each([
    ['無し', undefined],
    ['空', ''],
    ['別のスキーム', `Bearer ${encode('alice:secret')}`],
    ['Base64 でない', 'Basic !!!'],
    ['コロン無し', `Basic ${encode('alice')}`],
    ['ユーザー名が空', `Basic ${encode(':secret')}`],
  ])('%s は null を返す', (_label, header) => {
    expect(parseBasicAuth(header)).toBeNull();
  });
});

describe('authenticate', () => {
  it('正しい認証情報なら本人を返す', async () => {
    const world = createFakeWorld();
    world.addUser('alice');
    const user = await authenticate(basicHeader('alice'), world.deps.users);
    expect(user.name).toBe('alice');
  });

  it.each([
    ['パスワード違い', () => basicHeader('alice', 'wrong')],
    ['居ないユーザー', () => basicHeader('nobody', 'x')],
    ['パスワード無しで居ないユーザー', () => basicHeader('nobody', '')],
    ['ヘッダー無し', () => undefined],
  ])('%s は 401 で WWW-Authenticate を返す', async (_label, header) => {
    const world = createFakeWorld();
    world.addUser('alice');
    const error = await authenticate(header(), world.deps.users).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).headers['WWW-Authenticate']).toContain('Basic realm="Nakamaba"');
  });
});

describe('assertAdmin', () => {
  it('Admin だけ通す', () => {
    const world = createFakeWorld();
    expect(() => assertAdmin(world.addUser('root', 'admin'))).not.toThrow();
    expect(() => assertAdmin(world.addUser('alice'))).toThrowError(HttpError);
  });
});
