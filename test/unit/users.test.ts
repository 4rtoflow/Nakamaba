import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../../src/app/bootstrap.ts';
import type { User } from '../../src/app/deps.ts';
import { HttpError } from '../../src/app/http.ts';
import { verifyPassword } from '../../src/app/passwords.ts';
import {
  createUser,
  deleteUser,
  getUserPassword,
  regeneratePassword,
} from '../../src/app/users.ts';
import { createFakeWorld, type FakeWorld } from '../support/fakes.ts';

let world: FakeWorld;
let admin: User;

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

beforeEach(() => {
  world = createFakeWorld();
  admin = world.addUser('root', 'admin');
});

describe('createUser', () => {
  it('強いパスワードを生成し、ハッシュと暗号化した値を別々に保存する', async () => {
    const { user, password } = await createUser(world.deps, 'alice', 'member');
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(user).toEqual({ name: 'alice', role: 'member', createdAt: expect.any(String) });
    expect(world.passwords.get('alice')).toBe(password);
    const stored = world.users.get('alice');
    expect(stored?.passwordHash).not.toContain(password);
    expect(verifyPassword(password, stored?.passwordHash ?? '')).toBe(true);
  });

  it('応答にハッシュを含めない', async () => {
    const { user } = await createUser(world.deps, 'alice', 'member');
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('同じ名前は 409 にし、元のパスワードを変えない', async () => {
    await createUser(world.deps, 'alice', 'member');
    const before = world.passwords.get('alice');
    expect((await errorOf(createUser(world.deps, 'alice', 'member'))).status).toBe(409);
    expect(world.passwords.get('alice')).toBe(before);
  });

  it('不正な名前は 400 にする', async () => {
    expect((await errorOf(createUser(world.deps, 'Alice', 'member'))).status).toBe(400);
  });

  it('パスワードを保存できなければユーザーを残さない', async () => {
    world.deps.secrets.putPassword = async () => {
      throw new Error('SSM に書けません');
    };
    await expect(createUser(world.deps, 'alice', 'member')).rejects.toThrow('SSM に書けません');
    expect(world.users.has('alice')).toBe(false);
  });
});

describe('getUserPassword', () => {
  it('発行したパスワードを返す', async () => {
    const { password } = await createUser(world.deps, 'alice', 'member');
    await expect(getUserPassword(world.deps, 'alice')).resolves.toBe(password);
  });

  it('居ないユーザーは 404 にする', async () => {
    expect((await errorOf(getUserPassword(world.deps, 'none'))).code).toBe('user_not_found');
  });

  it('パスワードが見つからなければ 404 にする', async () => {
    await createUser(world.deps, 'alice', 'member');
    world.passwords.delete('alice');
    expect((await errorOf(getUserPassword(world.deps, 'alice'))).code).toBe('password_not_found');
  });
});

describe('regeneratePassword', () => {
  it('新しいパスワードに変え、古いものでは通らなくする', async () => {
    const { password: old } = await createUser(world.deps, 'alice', 'member');
    const next = await regeneratePassword(world.deps, 'alice');
    expect(next).not.toBe(old);
    const hash = world.users.get('alice')?.passwordHash ?? '';
    expect(verifyPassword(next, hash)).toBe(true);
    expect(verifyPassword(old, hash)).toBe(false);
    expect(world.passwords.get('alice')).toBe(next);
  });

  it('居ないユーザーは 404 にし、パスワードを作らない', async () => {
    expect((await errorOf(regeneratePassword(world.deps, 'none'))).status).toBe(404);
    expect(world.passwords.has('none')).toBe(false);
  });
});

describe('deleteUser', () => {
  it('ユーザーとパスワードを消す', async () => {
    await createUser(world.deps, 'alice', 'member');
    await deleteUser(world.deps, admin, 'alice');
    expect(world.users.has('alice')).toBe(false);
    expect(world.passwords.has('alice')).toBe(false);
  });

  it('自分自身は消せない', async () => {
    expect((await errorOf(deleteUser(world.deps, admin, 'root'))).code).toBe('cannot_delete_self');
  });

  it('他の Admin は消せない', async () => {
    world.addUser('root2', 'admin');
    expect((await errorOf(deleteUser(world.deps, admin, 'root2'))).code).toBe(
      'cannot_delete_admin',
    );
  });

  it('居ないユーザーは 404 にする', async () => {
    expect((await errorOf(deleteUser(world.deps, admin, 'none'))).status).toBe(404);
  });
});

describe('bootstrapAdmin', () => {
  it('Admin を作り、トップと 404 を置く', async () => {
    const empty = createFakeWorld();
    const { password } = await bootstrapAdmin(empty.deps, 'root');
    expect(empty.users.get('root')?.role).toBe('admin');
    expect(empty.passwords.get('root')).toBe(password);
    expect(empty.siteFiles.has('index.html')).toBe(true);
    expect(empty.siteFiles.has('404.html')).toBe(true);
  });

  it('既に同じ名前があれば失敗し、パスワードを変えない', async () => {
    const before = world.passwords.get('root');
    await expect(bootstrapAdmin(world.deps, 'root')).rejects.toThrow(HttpError);
    expect(world.passwords.get('root')).toBe(before);
  });
});
