import type { Deps, Role, User } from './deps.ts';
import { HttpError } from './http.ts';
import { assertValidName } from './names.ts';
import { generatePassword, hashPassword } from './passwords.ts';

export interface PublicUser {
  name: string;
  role: Role;
  createdAt: string;
}

export function toPublicUser(user: User): PublicUser {
  return { name: user.name, role: user.role, createdAt: user.createdAt };
}

function notFound(): HttpError {
  return new HttpError(404, 'user_not_found', 'ユーザーが見つかりません。');
}

export async function createUser(
  deps: Pick<Deps, 'users' | 'secrets' | 'now'>,
  name: string,
  role: Role,
): Promise<{ user: PublicUser; password: string }> {
  assertValidName(name);
  const password = generatePassword();
  const user: User = {
    name,
    role,
    passwordHash: hashPassword(password),
    createdAt: deps.now().toISOString(),
  };
  if (!(await deps.users.create(user))) {
    throw new HttpError(409, 'user_exists', 'このユーザー名は既に使われています。');
  }
  try {
    await deps.secrets.putPassword(name, password);
  } catch (error) {
    await deps.users.delete(name);
    throw error;
  }
  return { user: toPublicUser(user), password };
}

export async function getUserPassword(
  deps: Pick<Deps, 'users' | 'secrets'>,
  name: string,
): Promise<string> {
  assertValidName(name);
  if (!(await deps.users.get(name))) throw notFound();
  const password = await deps.secrets.getPassword(name);
  if (password === null) {
    throw new HttpError(
      404,
      'password_not_found',
      'パスワードが見つかりません。再発行してください。',
    );
  }
  return password;
}

export async function regeneratePassword(
  deps: Pick<Deps, 'users' | 'secrets'>,
  name: string,
): Promise<string> {
  assertValidName(name);
  if (!(await deps.users.get(name))) throw notFound();
  const password = generatePassword();
  await deps.secrets.putPassword(name, password);
  if (!(await deps.users.setPasswordHash(name, hashPassword(password)))) throw notFound();
  return password;
}

export async function deleteUser(
  deps: Pick<Deps, 'users' | 'secrets'>,
  actor: User,
  name: string,
): Promise<void> {
  assertValidName(name);
  if (name === actor.name) {
    throw new HttpError(409, 'cannot_delete_self', '自分自身は削除できません。');
  }
  const target = await deps.users.get(name);
  if (!target) throw notFound();
  if (target.role === 'admin') {
    throw new HttpError(409, 'cannot_delete_admin', 'Admin は削除できません。');
  }
  await deps.users.delete(name);
  await deps.secrets.deletePassword(name);
}
