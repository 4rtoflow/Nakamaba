import { readFileSync } from 'node:fs';

// ビルド後も同じ相対パスになるよう、CDK のバンドル時に admin-assets をコピーしている
function asset(name: string): string {
  return readFileSync(new URL(`./admin-assets/${name}`, import.meta.url), 'utf8');
}

export const ADMIN_HTML = asset('index.html');
export const ADMIN_CSS = asset('admin.css');
export const ADMIN_JS = asset('admin.js');
export const FAVICON_SVG = asset('favicon.svg');

function binaryAsset(name: string): Buffer {
  return readFileSync(new URL(`./admin-assets/${name}`, import.meta.url));
}

// 公開側のルートに置く。友人のページでも、ブラウザが自動で取りに行く /favicon.ico が見つかる
export const SITE_ICONS = [
  { key: 'favicon.svg', body: FAVICON_SVG, contentType: 'image/svg+xml' },
  { key: 'favicon.ico', body: binaryAsset('favicon.ico'), contentType: 'image/x-icon' },
  {
    key: 'apple-touch-icon.png',
    body: binaryAsset('apple-touch-icon.png'),
    contentType: 'image/png',
  },
];

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
