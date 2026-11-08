import type { AgentToken, Deps, User } from './deps.ts';
import { HttpError } from './http.ts';
import { hashPassword, verifyPassword } from './passwords.ts';
import { verifyToken } from './tokens.ts';

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

/** 認証した人。token はエージェント用のトークンで認証したときのトークンで、パスワードなら null */
export interface Principal {
  user: User;
  token: AgentToken | null;
}

/** `Bearer <トークン>` のトークンを取り出す。Bearer でなければ null */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  return /^bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? null;
}

export async function authenticate(
  header: string | undefined,
  deps: Pick<Deps, 'users' | 'tokens' | 'now'>,
): Promise<Principal> {
  const bearer = parseBearer(header);
  if (bearer !== null) {
    const verified = await verifyToken(deps, bearer);
    if (!verified) throw unauthorized();
    return verified;
  }
  const credentials = parseBasicAuth(header);
  if (!credentials) throw unauthorized();
  const user = await deps.users.get(credentials.username);
  const matches = verifyPassword(credentials.password, user?.passwordHash ?? NO_USER_HASH);
  if (!user || !matches) throw unauthorized();
  return { user, token: null };
}

export function assertAdmin(user: User): void {
  if (user.role !== 'admin') {
    throw new HttpError(403, 'admin_only', 'この操作は Admin だけができます。');
  }
}
