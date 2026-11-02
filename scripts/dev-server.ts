// 手元で動かすための環境。moto（AWS の模擬サーバー）に接続し、管理画面と公開側を別オリジンで起動する。
// 実際の AWS へは接続しない。使い方: npm run dev
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createAwsDeps } from '../src/app/aws.ts';
import { bootstrapAdmin } from '../src/app/bootstrap.ts';
import type { AppRequest } from '../src/app/http.ts';
import { handleRequest } from '../src/app/router.ts';
import { provisionLocalAws } from '../test/support/local-aws.ts';
import { startMoto } from '../test/support/moto.ts';

const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 4100);
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 4200);
const ADMIN_ORIGIN = `http://127.0.0.1:${ADMIN_PORT}`;
const PUBLIC_ORIGIN = `http://127.0.0.1:${PUBLIC_PORT}`;
const ADMIN_NAME = 'admin';

type EdgeResult =
  | { uri: string }
  | { statusCode: number; headers: { location: { value: string } } };

const edgeHandler = new Function(
  `${readFileSync(new URL('../src/edge/rewrite.js', import.meta.url), 'utf8')}; return handler;`,
)() as (event: {
  request: { uri: string; querystring: Record<string, { value: string }> };
}) => EdgeResult;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const moto = await startMoto();
process.on('exit', () => moto.stop());
const config = await provisionLocalAws(moto.endpoint, {
  publicBaseUrl: PUBLIC_ORIGIN,
  adminOrigin: ADMIN_ORIGIN,
});
const deps = createAwsDeps(config);
const s3 = new S3Client({ forcePathStyle: true });
const { password } = await bootstrapAdmin(deps, ADMIN_NAME);

// 管理画面と API（本番の Lambda の関数 URL にあたる）
const adminServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', ADMIN_ORIGIN);
  const appRequest: AppRequest = {
    method: request.method ?? 'GET',
    path: url.pathname,
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value.join(',') : value,
      ]),
    ),
    body: await readBody(request),
  };
  const result = await handleRequest(deps, appRequest);
  // 本番の関数 URL と同じく、WWW-Authenticate を別の名前に変える（ブラウザのダイアログを出さない）
  const { 'WWW-Authenticate': challenge, ...headers } = result.headers;
  response.writeHead(
    result.status,
    challenge ? { ...headers, 'x-amzn-Remapped-www-authenticate': challenge } : headers,
  );
  response.end(result.body);
});

// 公開側（本番の CloudFront にあたる）。本番と同じ書き換えの関数を通し、S3 から返す
const publicServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', PUBLIC_ORIGIN);
  const querystring = Object.fromEntries(
    [...url.searchParams.entries()].map(([name, value]) => [name, { value }]),
  );
  const edge = edgeHandler({ request: { uri: decodeURI(url.pathname), querystring } });
  if ('statusCode' in edge) {
    response.writeHead(edge.statusCode, { Location: edge.headers.location.value });
    response.end();
    return;
  }
  const fetchKey = async (key: string) =>
    s3.send(new GetObjectCommand({ Bucket: config.siteBucket, Key: key }));
  try {
    const object = await fetchKey(edge.uri.slice(1));
    response.writeHead(200, { 'Content-Type': object.ContentType ?? 'application/octet-stream' });
    response.end(await object.Body?.transformToByteArray());
  } catch {
    const object = await fetchKey('404.html');
    response.writeHead(404, { 'Content-Type': object.ContentType ?? 'text/html; charset=utf-8' });
    response.end(await object.Body?.transformToByteArray());
  }
});

await new Promise<void>((resolve) => adminServer.listen(ADMIN_PORT, '127.0.0.1', resolve));
await new Promise<void>((resolve) => publicServer.listen(PUBLIC_PORT, '127.0.0.1', resolve));

const stateFile = process.env.DEV_STATE_FILE;
if (stateFile) {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      adminOrigin: ADMIN_ORIGIN,
      publicOrigin: PUBLIC_ORIGIN,
      adminName: ADMIN_NAME,
      password,
    }),
  );
}

console.log(`管理画面: ${ADMIN_ORIGIN}（ユーザー名 ${ADMIN_NAME} / パスワード ${password}）`);
console.log(`公開側:   ${PUBLIC_ORIGIN}`);

function shutdown() {
  adminServer.close();
  publicServer.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
