import { createHash, randomBytes } from 'node:crypto';
import type { AgentToken, Deps, User } from './deps.ts';
import { HttpError } from './http.ts';

/**
 * エージェント用のトークン。AI エージェントが、本人の名前でページを公開・更新するために使う。
 * 秘密を預かる仕組み（Claude Managed Agents の vault など）は、ヘッダーの中のダミーをそのまま本物に差し替えるので、
 * スクリプトは `Authorization: Bearer <トークン>` と書くだけで済む（Basic 認証のように組み立て直さない）。
 */

const PREFIX = 'nkmb_';
// 決まった接頭辞があると、gitleaks などで漏れを見つけやすい（.gitleaks.toml にも同じ形を書く）
const TOKEN = /^nkmb_[A-Za-z0-9_-]{43}$/;
/** この日数のあいだ使われなかったトークンは使えない（一度も使っていなければ、発行日時から数える） */
export const TOKEN_INACTIVE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LABEL_LENGTH = 50;

/** 一覧と発行の応答に出す形。ハッシュは出さない */
export interface PublicToken {
  id: string;
  owner: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** false なら、長く使われなかったため使えない */
  active: boolean;
}

export function generateToken(): string {
  return `${PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** パスワードと同じく 256 ビットの乱数なので、総当たりを遅らせるハッシュは要らない */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isActive(token: AgentToken, now: Date): boolean {
  const last = Date.parse(token.lastUsedAt ?? token.createdAt);
  return now.getTime() - last < TOKEN_INACTIVE_DAYS * DAY_MS;
}

function needsTouch(token: AgentToken, now: Date): boolean {
  return token.lastUsedAt === undefined || now.getTime() - Date.parse(token.lastUsedAt) >= DAY_MS;
}

export function toPublicToken(token: AgentToken, now: Date): PublicToken {
  return {
    id: token.id,
    owner: token.owner,
    label: token.label,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt ?? null,
    active: isActive(token, now),
  };
}

function invalidLabel(): HttpError {
  return new HttpError(400, 'invalid_label', 'トークンの名前は、1〜50 文字で付けてください。');
}

function tokenNotFound(): HttpError {
  return new HttpError(404, 'token_not_found', 'トークンが見つかりません。');
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') throw invalidLabel();
  const label = value.trim();
  // 制御文字は一覧の表示を崩すので受け付けない
  if (label === '' || [...label].length > MAX_LABEL_LENGTH || /\p{Cc}/u.test(label)) {
    throw invalidLabel();
  }
  return label;
}

/** 本人のトークンを発行する。本物の値は、この応答で 1 回だけ返す */
export async function issueToken(
  deps: Pick<Deps, 'tokens' | 'now'>,
  owner: User,
  label: unknown,
): Promise<PublicToken & { token: string }> {
  const record: Omit<AgentToken, 'hash' | 'id'> = {
    owner: owner.name,
    label: normalizeLabel(label),
    createdAt: deps.now().toISOString(),
  };
  const token = generateToken();
  const hash = hashToken(token);
  const stored: AgentToken = { hash, id: hash.slice(0, 16), ...record };
  await deps.tokens.create(stored);
  return { token, ...toPublicToken(stored, deps.now()) };
}

/** 本人のトークンの一覧。Admin には全員の分を返す。新しい順 */
export async function listTokens(
  deps: Pick<Deps, 'tokens' | 'now'>,
  viewer: User,
): Promise<PublicToken[]> {
  const now = deps.now();
  const tokens = await deps.tokens.list();
  return tokens
    .filter((token) => viewer.role === 'admin' || token.owner === viewer.name)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((token) => toPublicToken(token, now));
}

/** 取り消せるのは、本人と Admin だけ。ほかの人のトークンは、有るか無いかも知らせない */
export async function revokeToken(
  deps: Pick<Deps, 'tokens'>,
  actor: User,
  id: string,
): Promise<void> {
  const target = (await deps.tokens.list()).find((token) => token.id === id);
  if (!target || (target.owner !== actor.name && actor.role !== 'admin')) throw tokenNotFound();
  await deps.tokens.delete(target.hash);
}

/** ユーザーのトークンをすべて取り消す（パスワードの再発行と、ユーザーの削除で使う） */
export async function revokeTokensOf(deps: Pick<Deps, 'tokens'>, owner: string): Promise<void> {
  for (const token of await deps.tokens.list()) {
    if (token.owner === owner) await deps.tokens.delete(token.hash);
  }
}

/**
 * Bearer で送られたトークンを確かめ、持ち主とトークンを返す。使えなければ null。
 * 形が違う、取り消された、長く使われなかった、持ち主が居ない、のどれでも同じく null にする
 */
export async function verifyToken(
  deps: Pick<Deps, 'users' | 'tokens' | 'now'>,
  value: string,
): Promise<{ user: User; token: AgentToken } | null> {
  if (!TOKEN.test(value)) return null;
  const token = await deps.tokens.get(hashToken(value));
  const now = deps.now();
  if (!token || !isActive(token, now)) return null;
  const user = await deps.users.get(token.owner);
  if (!user) return null;
  if (needsTouch(token, now)) await deps.tokens.touch(token.hash, now.toISOString());
  return { user, token };
}
