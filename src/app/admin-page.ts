import { readFileSync } from 'node:fs';

// ビルド後も同じ相対パスになるよう、CDK のバンドル時に admin-assets をコピーしている
function asset(name: string): string {
  return readFileSync(new URL(`./admin-assets/${name}`, import.meta.url), 'utf8');
}

export const ADMIN_HTML = asset('index.html');
export const ADMIN_CSS = asset('admin.css');
export const ADMIN_JS = asset('admin.js');

export function adminCsp(uploadOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `connect-src 'self' ${uploadOrigin}`,
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
