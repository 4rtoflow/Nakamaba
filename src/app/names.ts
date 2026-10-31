import { HttpError } from './http.ts';

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** ページ名とユーザー名の共通の規則。URL と S3 のキーにそのまま使うので、ここで絞る。 */
export function isValidName(value: string): boolean {
  return NAME.test(value);
}

export function assertValidName(value: string): void {
  if (!isValidName(value)) {
    throw new HttpError(
      400,
      'invalid_name',
      '名前は英小文字・数字・ハイフンだけで、63 文字までです。先頭と末尾にハイフンは使えません。',
    );
  }
}
