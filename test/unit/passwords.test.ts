import { describe, expect, it } from 'vitest';
import { generatePassword, hashPassword, verifyPassword } from '../../src/app/passwords.ts';

describe('generatePassword', () => {
  it('256 ビットの乱数を URL 安全な文字で返す', () => {
    const password = generatePassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('Basic 認証の区切りのコロンを含まない', () => {
    for (let i = 0; i < 100; i += 1) expect(generatePassword()).not.toContain(':');
  });

  it('毎回違う値になる', () => {
    const passwords = new Set(Array.from({ length: 100 }, generatePassword));
    expect(passwords.size).toBe(100);
  });
});

describe('verifyPassword', () => {
  it('同じパスワードだけ通す', () => {
    const hash = hashPassword('correct');
    expect(verifyPassword('correct', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('ハッシュの形式が壊れていても例外にせず通さない', () => {
    expect(verifyPassword('correct', 'not-hex')).toBe(false);
    expect(verifyPassword('correct', '')).toBe(false);
  });

  it('ハッシュにパスワードそのものを残さない', () => {
    expect(hashPassword('correct')).not.toContain('correct');
  });
});
