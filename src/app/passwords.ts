import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generatePassword(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 256 ビットの乱数のパスワードだけを扱うので、総当たりを遅らせるハッシュは要らない。
 * Basic 認証はリクエストごとに確かめるため、遅い方式は毎回の待ち時間になる。
 */
export function hashPassword(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex');
}

export function verifyPassword(password: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
