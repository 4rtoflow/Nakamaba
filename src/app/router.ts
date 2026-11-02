import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS, adminCsp } from './admin-page.ts';
import { assertAdmin, authenticate } from './auth.ts';
import type { Deps, User } from './deps.ts';
import {
  type AppRequest,
  type AppResponse,
  errorResponse,
  HttpError,
  json,
  respond,
} from './http.ts';
import { createUpload, deletePage, publishPage } from './publish.ts';
import {
  createUser,
  deleteUser,
  getUserPassword,
  regeneratePassword,
  toPublicUser,
} from './users.ts';

// POST を受け付けないのは、フォーム送信なら別オリジンからでも CORS の確認なしに届くため。
// PUT と DELETE はブラウザが事前に確認し、許可しなければ送られない。
const ALLOWED_METHODS = 'GET, PUT, DELETE';

function parseJsonBody(body: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body || '{}');
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON の形式が正しくありません。');
  }
}

function notFound(): HttpError {
  return new HttpError(404, 'not_found', '見つかりません。');
}

function segmentsOf(path: string): string[] {
  try {
    return path.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw notFound();
  }
}

async function routePages(
  deps: Deps,
  user: User,
  request: AppRequest,
  rest: string[],
): Promise<AppResponse> {
  const [name, action, ...extra] = rest;
  if (extra.length > 0) throw notFound();

  if (name === undefined) {
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    const pages = await deps.pages.list();
    return json(200, {
      pages: pages
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((page) => ({
          ...page,
          url: `${deps.publicBaseUrl}/${page.name}/`,
          canModify: page.owner === user.name || user.role === 'admin',
        })),
    });
  }

  if (action === 'upload') {
    if (request.method !== 'PUT') throw methodNotAllowed('PUT');
    return json(200, await createUpload(deps, user, name));
  }
  if (action !== undefined) throw notFound();

  if (request.method === 'PUT') {
    const { uploadId } = parseJsonBody(request.body);
    if (typeof uploadId !== 'string') {
      throw new HttpError(400, 'invalid_upload_id', 'uploadId が必要です。');
    }
    const result = await publishPage(deps, user, name, uploadId);
    return json(result.isNew ? 201 : 200, result);
  }
  if (request.method === 'DELETE') {
    await deletePage(deps, user, name);
    return json(200, { deleted: name });
  }
  throw methodNotAllowed('PUT, DELETE');
}

async function routeUsers(
  deps: Deps,
  user: User,
  request: AppRequest,
  rest: string[],
): Promise<AppResponse> {
  assertAdmin(user);
  const [name, action, ...extra] = rest;
  if (extra.length > 0) throw notFound();

  if (name === undefined) {
    if (request.method !== 'GET') throw methodNotAllowed('GET');
    const users = await deps.users.list();
    return json(200, {
      users: users.sort((a, b) => a.name.localeCompare(b.name)).map(toPublicUser),
    });
  }

  if (action === 'password') {
    if (request.method === 'GET') {
      return json(200, { password: await getUserPassword(deps, name) });
    }
    if (request.method === 'PUT') {
      return json(200, { password: await regeneratePassword(deps, name) });
    }
    throw methodNotAllowed('GET, PUT');
  }
  if (action !== undefined) throw notFound();

  if (request.method === 'PUT') {
    return json(201, await createUser(deps, name, 'member'));
  }
  if (request.method === 'DELETE') {
    await deleteUser(deps, user, name);
    return json(200, { deleted: name });
  }
  throw methodNotAllowed('PUT, DELETE');
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, 'method_not_allowed', 'このメソッドは使えません。', { Allow: allow });
}

async function route(deps: Deps, request: AppRequest): Promise<AppResponse> {
  if (!['GET', 'PUT', 'DELETE'].includes(request.method)) throw methodNotAllowed(ALLOWED_METHODS);

  // 画面のファイルに秘密は無い。ログインフォームを出すために、認証なしで返す
  if (request.method === 'GET') {
    if (request.path === '/') {
      return respond(200, ADMIN_HTML, 'text/html; charset=utf-8', {
        'Content-Security-Policy': adminCsp(deps.uploadOrigin),
      });
    }
    if (request.path === '/admin.js') {
      return respond(200, ADMIN_JS, 'text/javascript; charset=utf-8');
    }
    if (request.path === '/admin.css') {
      return respond(200, ADMIN_CSS, 'text/css; charset=utf-8');
    }
  }

  const user = await authenticate(request.headers.authorization, deps.users);

  if (request.method === 'GET' && request.path === '/api/me') {
    return json(200, { ...toPublicUser(user), publicBaseUrl: deps.publicBaseUrl });
  }

  const [api, resource, ...rest] = segmentsOf(request.path);
  if (api !== 'api') throw notFound();
  if (resource === 'pages') return routePages(deps, user, request, rest);
  if (resource === 'users') return routeUsers(deps, user, request, rest);
  throw notFound();
}

export async function handleRequest(deps: Deps, request: AppRequest): Promise<AppResponse> {
  try {
    return await route(deps, request);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error);
    deps.log('unexpected_error', {
      name: (error as Error).name,
      message: (error as Error).message,
      stack: (error as Error).stack,
    });
    return errorResponse(new HttpError(500, 'internal_error', 'サーバーでエラーが起きました。'));
  }
}
