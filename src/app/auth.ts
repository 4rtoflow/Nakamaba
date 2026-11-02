import type { User, UserStore } from './deps.ts';
import { HttpError } from './http.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

export interface BasicCredentials {
  username: string;
  password: string;
}

export function parseBasicAuth(header: string | undefined): BasicCredentials | null {
  if (!header) return null;
  const match = /^basic\s+([a-z0-9+/]+={0,2})\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

// ユーザーが居ないときも同じ比較を通し、名前の有無で処理が分からないようにする
const NO_USER_HASH = hashPassword('');

// 関数 URL はこのヘッダーを x-amzn-Remapped-www-authenticate に変えるので、ブラウザのダイアログは出ない。
// 管理画面はログインフォームから Authorization を付けて送る。
function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'ログインが必要です。', {
    'WWW-Authenticate': 'Basic realm="Nakamaba", charset="UTF-8"',
  });
}

export async function authenticate(header: string | undefined, users: UserStore): Promise<User> {
  const credentials = parseBasicAuth(header);
  if (!credentials) throw unauthorized();
  const user = await users.get(credentials.username);
  const matches = verifyPassword(credentials.password, user?.passwordHash ?? NO_USER_HASH);
  if (!user || !matches) throw unauthorized();
  return user;
}

export function assertAdmin(user: User): void {
  if (user.role !== 'admin') {
    throw new HttpError(403, 'admin_only', 'この操作は Admin だけができます。');
  }
}
