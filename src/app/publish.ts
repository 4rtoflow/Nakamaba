import { SITE_ICONS } from './admin-page.ts';
import type { Deps, Page, PresignedUpload, User } from './deps.ts';
import { HttpError } from './http.ts';
import { assertValidName } from './names.ts';
import { buildPage } from './page-content.ts';
import { renderNotFoundPage, renderTopPage } from './top-page.ts';
import { extractZip } from './zip.ts';

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HTML = 'text/html; charset=utf-8';

function canModify(user: User, page: Page | null): boolean {
  return page === null || page.owner === user.name || user.role === 'admin';
}

function nameTaken(): HttpError {
  return new HttpError(
    409,
    'name_taken',
    'この名前のページは他の人が公開しています。別の名前にしてください。',
  );
}

// 署名付き URL を発行した本人とページだけが、その zip を公開に使える
function uploadKey(user: User, pageName: string, uploadId: string): string {
  return `uploads/${user.name}/${pageName}/${uploadId}.zip`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`;
}

/** 実際に置かれているサイズを S3 から数える。exceptPage は上書きする前のページを除くために使う */
export async function usedBytes(
  deps: Pick<Deps, 'siteFiles'>,
  pages: Page[],
  owner: string,
  exceptPage?: string,
): Promise<number> {
  const sizes = await Promise.all(
    pages
      .filter((page) => page.owner === owner && page.name !== exceptPage)
      .map((page) => deps.siteFiles.totalBytes(`${page.name}/`)),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

export function pageUrl(deps: Deps, pageName: string): string {
  return `${deps.publicBaseUrl}/${pageName}/`;
}

export async function createUpload(
  deps: Deps,
  user: User,
  pageName: string,
): Promise<{ uploadId: string; upload: PresignedUpload; maxBytes: number }> {
  assertValidName(pageName);
  if (!canModify(user, await deps.pages.get(pageName))) throw nameTaken();
  const uploadId = deps.newId();
  const upload = await deps.uploads.createPresignedUpload(
    uploadKey(user, pageName, uploadId),
    deps.limits.maxZipBytes,
    deps.limits.uploadExpiresSeconds,
  );
  return { uploadId, upload, maxBytes: deps.limits.maxZipBytes };
}

export async function refreshTopPage(deps: Pick<Deps, 'pages' | 'siteFiles'>): Promise<void> {
  const pages = await deps.pages.list();
  await deps.siteFiles.put('index.html', renderTopPage(pages), HTML);
}

// 公開と削除のたびに置き直すので、アプリの更新は次の公開で公開側にも反映される
export async function writeStaticPages(deps: Pick<Deps, 'pages' | 'siteFiles'>): Promise<void> {
  await deps.siteFiles.put('404.html', renderNotFoundPage(), HTML);
  for (const icon of SITE_ICONS) await deps.siteFiles.put(icon.key, icon.body, icon.contentType);
  await refreshTopPage(deps);
}

export async function publishPage(
  deps: Deps,
  user: User,
  pageName: string,
  uploadId: string,
): Promise<{ page: Page; url: string; isNew: boolean }> {
  assertValidName(pageName);
  if (!UPLOAD_ID.test(uploadId)) {
    throw new HttpError(400, 'invalid_upload_id', 'uploadId の形式が正しくありません。');
  }
  const currentPage = await deps.pages.get(pageName);
  if (!canModify(user, currentPage)) throw nameTaken();

  const key = uploadKey(user, pageName, uploadId);
  const size = await deps.uploads.size(key);
  if (size === null) {
    throw new HttpError(404, 'upload_not_found', 'zip が見つかりません。送り直してください。');
  }
  if (size > deps.limits.maxZipBytes) {
    await deps.uploads.delete(key);
    throw new HttpError(413, 'zip_too_large', 'zip が大きすぎます。');
  }

  const files = await extractZip(await deps.uploads.read(key), deps.limits);
  const built = buildPage(files, pageName);

  // Admin が他の人のページを上書きしても持ち主は変わらないので、持ち主の分として数える
  const owner = currentPage?.owner ?? user.name;
  const used = await usedBytes(deps, await deps.pages.list(), owner, pageName);
  const pageBytes = built.files.reduce((sum, file) => sum + file.body.length, 0);
  if (used + pageBytes > deps.limits.maxBytesPerUser) {
    await deps.uploads.delete(key);
    throw new HttpError(
      413,
      'quota_exceeded',
      `1 人あたりの上限（${formatBytes(deps.limits.maxBytesPerUser)}）を超えます。使用中は ${formatBytes(used)}、このページは ${formatBytes(pageBytes)} です。不要なページを削除してください。`,
    );
  }

  const claim = await deps.pages.claim({
    name: pageName,
    actor: user.name,
    overrideOwner: user.role === 'admin',
    title: built.title,
    hasThumbnail: built.hasThumbnail,
    now: deps.now().toISOString(),
  });
  if (!claim.claimed) throw nameTaken();

  const prefix = `${pageName}/`;
  try {
    // 開いている人が壊れたページを見ないよう、index.html は最後に差し替える
    const ordered = [...built.files].sort(
      (a, b) => Number(a.path === 'index.html') - Number(b.path === 'index.html'),
    );
    for (const file of ordered) {
      await deps.siteFiles.put(`${prefix}${file.path}`, file.body, file.contentType);
    }
    const current = new Set(built.files.map((file) => `${prefix}${file.path}`));
    const existing = await deps.siteFiles.list(prefix);
    await deps.siteFiles.delete(existing.filter((existingKey) => !current.has(existingKey)));
  } catch (error) {
    if (claim.isNew) await deps.pages.delete(pageName);
    throw error;
  }

  await writeStaticPages(deps);
  await deps.cdn.invalidate([`/${pageName}/*`, '/index.html', '/']);
  await deps.uploads.delete(key);

  const url = pageUrl(deps, pageName);
  if (claim.isNew) {
    await deps.notifier.notifyNewPage({ title: claim.page.title, owner: claim.page.owner, url });
  }
  return { page: claim.page, url, isNew: claim.isNew };
}

export async function deletePage(deps: Deps, user: User, pageName: string): Promise<void> {
  assertValidName(pageName);
  const page = await deps.pages.get(pageName);
  if (!page) throw new HttpError(404, 'page_not_found', 'ページが見つかりません。');
  if (!canModify(user, page)) {
    throw new HttpError(
      403,
      'forbidden',
      'このページを削除できるのは、公開した人と Admin だけです。',
    );
  }
  const prefix = `${pageName}/`;
  await deps.siteFiles.delete(await deps.siteFiles.list(prefix));
  await deps.pages.delete(pageName);
  await writeStaticPages(deps);
  await deps.cdn.invalidate([`/${pageName}/*`, '/index.html', '/']);
}
