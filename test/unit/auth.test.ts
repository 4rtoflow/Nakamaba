import { describe, expect, it } from 'vitest';
import { assertAdmin, authenticate, parseBasicAuth, parseBearer } from '../../src/app/auth.ts';
import { HttpError } from '../../src/app/http.ts';
import { generateToken } from '../../src/app/tokens.ts';
import { basicHeader, bearerHeader, createFakeWorld } from '../support/fakes.ts';

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

describe('parseBearer', () => {
  it('トークンを取り出し、スキーム名の大文字小文字を区別しない', () => {
    expect(parseBearer('Bearer nkmb_abc')).toBe('nkmb_abc');
    expect(parseBearer('bearer nkmb_abc')).toBe('nkmb_abc');
  });

  it.each([
    ['無し', undefined],
    ['空', ''],
    ['Basic', `Basic ${encode('alice:secret')}`],
    ['トークン無し', 'Bearer '],
    ['空白を含む', 'Bearer a b'],
  ])('%s は null を返す', (_label, header) => {
    expect(parseBearer(header)).toBeNull();
  });
});

describe('authenticate', () => {
  it('正しいパスワードなら本人を返し、トークンは null', async () => {
    const world = createFakeWorld();
    world.addUser('alice');
    const principal = await authenticate(basicHeader('alice'), world.deps);
    expect(principal.user.name).toBe('alice');
    expect(principal.token).toBeNull();
  });

  it('正しいトークンなら、持ち主とトークンを返す', async () => {
    const world = createFakeWorld();
    world.addUser('alice');
    const token = await world.addToken('alice', 'Bobert');
    const principal = await authenticate(bearerHeader(token), world.deps);
    expect(principal.user.name).toBe('alice');
    expect(principal.token?.label).toBe('Bobert');
  });

  it.each([
    ['パスワード違い', () => basicHeader('alice', 'wrong')],
    ['居ないユーザー', () => basicHeader('nobody', 'x')],
    ['パスワード無しで居ないユーザー', () => basicHeader('nobody', '')],
    ['ヘッダー無し', () => undefined],
    ['形の違うトークン', () => bearerHeader('nkmb_short')],
    ['発行していないトークン', () => bearerHeader(generateToken())],
  ])('%s は 401 で WWW-Authenticate を返す', async (_label, header) => {
    const world = createFakeWorld();
    world.addUser('alice');
    const error = await authenticate(header(), world.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).headers['WWW-Authenticate']).toContain('Basic realm="Nakamaba"');
  });

  it('パスワードを Bearer で送っても通さない', async () => {
    const world = createFakeWorld();
    world.addUser('alice');
    const error = await authenticate(bearerHeader('alice-password'), world.deps).catch(
      (e: unknown) => e,
    );
    expect((error as HttpError).status).toBe(401);
  });

  it('持ち主が居なくなったトークンは通さない', async () => {
    const world = createFakeWorld();
    world.addUser('alice');
    const token = await world.addToken('alice');
    world.users.delete('alice');
    const error = await authenticate(bearerHeader(token), world.deps).catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(401);
  });
});

describe('assertAdmin', () => {
  it('Admin だけ通す', () => {
    const world = createFakeWorld();
    expect(() => assertAdmin(world.addUser('root', 'admin'))).not.toThrow();
    expect(() => assertAdmin(world.addUser('alice'))).toThrowError(HttpError);
  });
});
