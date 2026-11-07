#!/usr/bin/env node
// Nakamaba の API でフォルダを公開する。依存パッケージを持たない（プラグインはそのまま配られるため）。
import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PAGE_FILE = 'nakamaba.json';
const SKIPPED_DIRS = new Set(['node_modules']);
// サーバーの上限（src/app/deps.ts の DEFAULT_LIMITS）と同じ。大きなフォルダを読み込む前に止める
const MAX_FILES = 1000;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// 本人が login を実行できない環境（AI エージェントのサンドボックスなど）で、資格情報のファイルの代わりに使う
const AUTHORIZATION_ENV = 'NAKAMABA_AUTHORIZATION';
const ADMIN_URL_ENV = 'NAKAMABA_ADMIN_URL';

class CliError extends Error {}
class ConnectionError extends CliError {}

function credentialsPath() {
  return process.env.NAKAMABA_CREDENTIALS ?? join(homedir(), '.config', 'nakamaba', 'credentials');
}

function loginCommand() {
  return `node "${fileURLToPath(import.meta.url)}" login`;
}

function askLogin(reason) {
  return new CliError(
    `${reason}\nパスワードを会話に出さないため、本人に別のターミナルで次を実行してもらってください:\n  ${loginCommand()}`,
  );
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Number(value.toFixed(1))} ${units[unit]}`;
}

/**
 * 管理画面への認証。環境変数 NAKAMABA_AUTHORIZATION があれば、その値をそのまま Authorization ヘッダーに使い、
 * 管理画面の URL は NAKAMABA_ADMIN_URL から読む。秘密を預かる仕組み（Claude Managed Agents の vault など）は、
 * 本物の値をサンドボックスに入れず、外へ送るときにヘッダーの中の値を差し替えるので、値を組み立て直さない。
 * 無ければ、login で保存したファイルを使う
 */
async function readCredentials() {
  const authorization = process.env[AUTHORIZATION_ENV];
  if (authorization) {
    const adminUrl = process.env[ADMIN_URL_ENV];
    if (!adminUrl) {
      throw new CliError(
        `環境変数 ${AUTHORIZATION_ENV} を使うときは、管理画面の URL を環境変数 ${ADMIN_URL_ENV} で指定してください。`,
      );
    }
    return { adminUrl: adminOrigin(adminUrl), authorization, username: null, fromEnv: true };
  }
  return readSavedCredentials();
}

async function readSavedCredentials() {
  let text;
  try {
    text = await readFile(credentialsPath(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw askLogin('まだログインしていません。');
    throw error;
  }
  try {
    const value = JSON.parse(text);
    if ([value.adminUrl, value.username, value.password].every((v) => typeof v === 'string')) {
      return {
        adminUrl: value.adminUrl,
        authorization: basicAuthorization(value.username, value.password),
        username: value.username,
        fromEnv: false,
      };
    }
  } catch {
    // 下で同じエラーにする
  }
  throw askLogin(`${credentialsPath()} の形式が正しくありません。`);
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function request(credentials, method, path, body) {
  let response;
  try {
    response = await fetch(`${credentials.adminUrl}${path}`, {
      method,
      headers: {
        authorization: credentials.authorization,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ConnectionError(
      `管理画面に接続できません（${credentials.adminUrl}）: ${error.cause?.code || error.cause?.message || error.message}`,
    );
  }
  let data = {};
  try {
    data = JSON.parse(await response.text());
  } catch {
    // JSON でない応答は、下で HTTP のステータスだけを伝える
  }
  return { status: response.status, ok: response.ok, data };
}

async function api(credentials, method, path, body) {
  let response;
  try {
    response = await request(credentials, method, path, body);
  } catch (error) {
    if (error instanceof ConnectionError && credentials.fromEnv) {
      throw new CliError(
        `${error.message}\nネットワークと、環境変数 ${ADMIN_URL_ENV} の URL を確かめてください。`,
      );
    }
    // 保存した URL が古い（開発サーバーのままなど）こともあるので、login のやり直しも示す
    if (error instanceof ConnectionError) {
      throw askLogin(
        `${error.message}\nネットワークを確かめ、管理画面の URL が違うときは login をやり直します。`,
      );
    }
    throw error;
  }
  if (response.status === 401 && credentials.fromEnv) {
    throw new CliError(
      `環境変数 ${AUTHORIZATION_ENV} の値では、ログインできませんでした。値が正しいかを、本人に確かめてもらってください。`,
    );
  }
  if (response.status === 401) throw askLogin('ユーザー名かパスワードが違います。');
  if (!response.ok) {
    throw new CliError(
      response.data.message ?? `管理画面がエラーを返しました（HTTP ${response.status}）。`,
    );
  }
  return response.data;
}

/** 公開するファイルを並べる。. で始まるもの（.env・.git など）とシンボリックリンクは送らない */
async function listFiles(root) {
  const files = [];
  const skipped = [];
  let totalBytes = 0;

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const path = relative(root, full).split(sep).join('/');
      if (entry.name === '.DS_Store') continue;
      if (entry.name.startsWith('.') || path === PAGE_FILE || entry.isSymbolicLink()) {
        skipped.push(path);
      } else if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) skipped.push(`${path}/`);
        else await walk(full);
      } else if (entry.isFile()) {
        totalBytes += (await stat(full)).size;
        if (files.length + 1 > MAX_FILES) {
          throw new CliError(`ファイルが多すぎます（上限 ${MAX_FILES} 個）。`);
        }
        if (totalBytes > MAX_UNZIPPED_BYTES) {
          throw new CliError(
            `ファイルの合計が上限（${formatBytes(MAX_UNZIPPED_BYTES)}）を超えます。`,
          );
        }
        files.push({ path, full });
      }
    }
  }

  await walk(root);
  return { files, skipped };
}

async function readFiles(listed) {
  const files = [];
  for (const file of listed) files.push({ path: file.path, body: await readFile(file.full) });
  return files;
}

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const deflated = deflateRawSync(file.body);
    const method = deflated.length < file.body.length ? 8 : 0;
    const data = method === 8 ? deflated : file.body;
    const crc = crc32(file.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // ファイル名は UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(33, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(file.body.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix で作成
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(file.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0o100644 * 0x10000, 38); // 通常のファイル
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

async function readSavedName(root) {
  let text;
  try {
    text = await readFile(join(root, PAGE_FILE), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const { name } = JSON.parse(text);
    if (typeof name === 'string') return name;
  } catch {
    // 下で同じエラーにする
  }
  throw new CliError(
    `${PAGE_FILE} の形式が正しくありません。{"name": "<ページ名>"} にしてください。`,
  );
}

/** フォルダとページ名を確かめ、送るファイルを並べる。defaultName が無ければページ名は必須 */
async function openFolder(values, positionals, defaultName) {
  if (positionals.length > 1) throw new CliError('フォルダは 1 つだけ指定してください。');
  const root = resolve(positionals[0] ?? '.');
  if (!(await lstat(root).catch(() => null))?.isDirectory()) {
    throw new CliError(`フォルダが見つかりません: ${root}`);
  }

  const saved = await readSavedName(root);
  if (saved && values.name && saved !== values.name) {
    throw new CliError(
      `このフォルダは「${saved}」として公開済みです（${PAGE_FILE}）。別の名前で公開するなら、${PAGE_FILE} を消してから実行してください。`,
    );
  }
  const name = saved ?? values.name ?? defaultName;
  if (!name)
    throw new CliError('ページ名を --name で指定してください。ページ名は URL になります。');
  if (!NAME.test(name)) {
    throw new CliError(
      'ページ名は英小文字・数字・ハイフンだけで、63 文字までです。先頭と末尾にハイフンは使えません。',
    );
  }

  const { files, skipped } = await listFiles(root);
  if (!files.some((file) => file.path === 'index.html' || file.path === 'index.md')) {
    throw new CliError('フォルダの直下に index.html か index.md が必要です。');
  }
  return { root, saved, name, listed: files, skipped };
}

async function publish(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: 'string' }, overwrite: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const { root, saved, name, listed, skipped } = await openFolder(values, positionals);
  const files = await readFiles(listed);

  const credentials = await readCredentials();
  if (!saved) {
    const { pages } = await api(credentials, 'GET', '/api/pages');
    const existing = pages.find((page) => page.name === name);
    if (existing && !existing.canModify) {
      throw new CliError(
        `「${name}」は ${existing.owner} が公開しています。別の名前にしてください。`,
      );
    }
    if (existing && !values.overwrite) {
      throw new CliError(
        `「${name}」は既に公開されています（${existing.url}）。このフォルダで上書きしてよいかユーザーに確かめ、よければ --overwrite を付けて実行し直してください。`,
      );
    }
  }

  const zip = buildZip(files);
  const created = await api(credentials, 'PUT', `/api/pages/${name}/upload`);
  if (zip.length > created.maxBytes) {
    throw new CliError(
      `zip が上限（${formatBytes(created.maxBytes)}）を超えます（${formatBytes(zip.length)}）。`,
    );
  }
  const form = new FormData();
  for (const [field, value] of Object.entries(created.upload.fields)) form.append(field, value);
  form.append('file', new Blob([zip], { type: 'application/zip' }));
  const sent = await fetch(created.upload.url, { method: 'POST', body: form }).catch((error) => {
    throw new CliError(
      `zip を送れませんでした: ${error.cause?.code || error.cause?.message || error.message}`,
    );
  });
  if (!sent.ok) throw new CliError(`zip を送れませんでした（HTTP ${sent.status}）。`);

  const result = await api(credentials, 'PUT', `/api/pages/${name}`, {
    uploadId: created.uploadId,
  });
  if (!saved) await writeFile(join(root, PAGE_FILE), `${JSON.stringify({ name }, null, 2)}\n`);

  console.log(`${result.isNew ? '公開しました' : '更新しました'}: ${result.url}`);
  if (skipped.length > 0) console.log(`送らなかったもの: ${skipped.join(', ')}`);
}

async function list() {
  const credentials = await readCredentials();
  // 環境変数の値からは、ユーザー名が分からないので、管理画面に聞く
  const username = credentials.username ?? (await api(credentials, 'GET', '/api/me')).name;
  const { pages, usage } = await api(credentials, 'GET', '/api/pages');
  console.log(
    `${username} の使用量: ${formatBytes(usage.usedBytes)} / ${formatBytes(usage.maxBytes)}`,
  );
  for (const page of pages) {
    const mine = page.canModify ? '' : '（更新できない）';
    console.log(`${page.name}\t${page.title}\t${page.owner}\t${page.url}${mine}`);
  }
}

// サーバーの src/app/mime.ts と同じ
const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  csv: 'text/csv; charset=utf-8',
};
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
// / で始まるパスは、公開すると Nakamaba の直下を指し、ページの中のファイルに届かない
const ROOT_RELATIVE = [
  /\b(?:href|src|srcset|action|poster)\s*=\s*["']?(\/(?!\/)[^"'\s>]+)/gi,
  /url\(\s*["']?(\/(?!\/)[^"')\s]+)/gi,
  /\]\(\s*<?(\/(?!\/)[^)\s>]+)/g,
];

function contentTypeFor(path) {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[fileName.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

function plainText(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => entities[entity])
    .replace(/\s+/g, ' ')
    .trim();
}

/** トップのカードに出る名前。サーバーと同じく index.html の <title>、index.md の最初の見出し、ページ名の順 */
function cardTitle(files, name) {
  const html = files.find((file) => file.path === 'index.html');
  const title = html && /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html.body.toString('utf8'));
  if (title && plainText(title[1])) return plainText(title[1]);
  const markdown = files.find((file) => file.path === 'index.md');
  const heading =
    markdown &&
    /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m.exec(markdown.body.toString('utf8'));
  return heading ? heading[1].trim() : name;
}

function findRootRelativeLinks(files) {
  const found = [];
  for (const file of files) {
    if (!/\.(?:html?|css|md|svg)$/i.test(file.path)) continue;
    file.body
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const pattern of ROOT_RELATIVE) {
          for (const match of line.matchAll(pattern)) {
            found.push(`${file.path}:${index + 1} ${match[1]}`);
          }
        }
      });
  }
  return found;
}

/** 公開後と同じ /<ページ名>/ の形で、フォルダのファイルを返す。読むたびに並べ直すので、直せば反映される */
async function servePreview(root, name, request, response) {
  const send = (status, headers, body = '') => {
    response.writeHead(status, headers);
    response.end(body);
  };
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(400, TEXT, 'URL の形式が正しくありません。');
  }
  const base = `/${name}/`;
  if (pathname === '/') return send(302, { location: base });
  if (pathname === `/${name}`) return send(301, { location: `${base}${url.search}` });
  if (!pathname.startsWith(base)) {
    return send(404, TEXT, `${pathname} はページの外です。公開すると Nakamaba の直下を指します。`);
  }

  let path = pathname.slice(base.length);
  if (path === '' || path.endsWith('/')) {
    path += 'index.html';
  } else if (!path.slice(path.lastIndexOf('/') + 1).includes('.')) {
    // 公開側と同じく、末尾の / が無いと相対リンクが 1 つ上を指すので転送する
    return send(301, { location: `${pathname}/${url.search}` });
  }
  if (/\.md$/i.test(path)) {
    return send(404, TEXT, `${path} は公開すると .html に変わるので、この URL では開けません。`);
  }

  const { files } = await listFiles(root);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const file = byPath.get(path) ?? byPath.get(path.replace(/\.html$/, '.md'));
  if (!file) return send(404, TEXT, `${path} はありません。公開しても 404 になります。`);
  // Markdown は公開するときにサーバーが HTML にするので、下見では文字のまま返す
  const type = file.path === path ? contentTypeFor(path) : 'text/plain; charset=utf-8';
  send(200, { 'content-type': type, 'cache-control': 'no-store' }, await readFile(file.full));
}

async function preview(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: 'string' }, port: { type: 'string', default: '0' } },
    allowPositionals: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError('--port には 0〜65535 の数を指定してください。');
  }
  const { root, name, listed, skipped } = await openFolder(values, positionals, 'preview');
  const files = await readFiles(listed);

  const outputs = new Set();
  for (const file of files) {
    const output = file.path.replace(/\.md$/i, '.html');
    if (outputs.has(output)) {
      throw new CliError(`Markdown を変換すると同じパスになります: ${output}`);
    }
    outputs.add(output);
  }
  const zipBytes = buildZip(files).length;
  if (zipBytes > MAX_ZIP_BYTES) {
    throw new CliError(
      `zip にすると上限（${formatBytes(MAX_ZIP_BYTES)}）を超えます（${formatBytes(zipBytes)}）。`,
    );
  }

  const server = createServer((request, response) => {
    servePreview(root, name, request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, TEXT);
      response.end(error instanceof CliError ? error.message : String(error));
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', (error) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new CliError(`ポート ${port} は使われています。--port で別の番号を指定してください。`)
          : error,
      );
    });
    server.listen(port, '127.0.0.1', resolveListen);
  });

  const lines = [
    `下見: http://127.0.0.1:${server.address().port}/${name}/`,
    `カードの名前: ${cardTitle(files, name)}`,
    `カードの画像: ${files.some((file) => file.path === 'thumbnail.png') ? 'thumbnail.png' : 'なし（グラデーションにタイトルの最初の文字を重ねる）'}`,
    `ファイル: ${files.length} 個・zip にして ${formatBytes(zipBytes)}`,
  ];
  if (skipped.length > 0) lines.push(`送らないもの: ${skipped.join(', ')}`);
  const links = findRootRelativeLinks(files);
  if (links.length > 0) {
    lines.push(
      '/ で始まるパスがあります。公開すると Nakamaba の直下を指して壊れるので、相対パスにしてください:',
      ...links.slice(0, 20).map((link) => `  ${link}`),
    );
    if (links.length > 20) lines.push(`  ほか ${links.length - 20} か所`);
  }
  if (files.some((file) => /\.md$/i.test(file.path))) {
    lines.push('Markdown は公開するときに HTML へ変換されるので、下見では文字のまま表示します。');
  }
  lines.push('ファイルを直したら、ブラウザで読み込み直せば反映されます。Ctrl-C で止めます。');
  console.log(lines.join('\n'));
}

function prompter() {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    process.exit(130);
  });
  // 先に読まれた行も取りこぼさないよう、行を溜めて 1 つずつ受け取る
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question, hidden = false) {
      if (hidden) {
        process.stdout.write(question);
        rl.setPrompt('');
        muted = true;
      } else {
        rl.setPrompt(question);
        rl.prompt();
      }
      const { value, done } = await lines.next();
      muted = false;
      if (hidden) process.stdout.write('\n');
      if (done) throw new CliError('入力が途中で終わりました。');
      return value.trim();
    },
    close: () => rl.close(),
  };
}

function adminOrigin(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(`URL の形式が正しくありません: ${input}`);
  }
  // http ではパスワードが暗号化されずに流れる。手元の開発環境だけ許す
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new CliError('管理画面の URL は https:// で始めてください。');
  }
  return url.origin;
}

async function login() {
  const io = prompter();
  let credentials;
  try {
    const adminUrl = adminOrigin(await io.ask('管理画面の URL: '));
    const username = await io.ask('ユーザー名: ');
    const password = await io.ask('パスワード（入力は表示されません）: ', true);
    credentials = { adminUrl, username, password };
  } finally {
    io.close();
  }

  const response = await request(
    {
      adminUrl: credentials.adminUrl,
      authorization: basicAuthorization(credentials.username, credentials.password),
    },
    'GET',
    '/api/me',
  );
  if (response.status === 401) {
    throw new CliError('ユーザー名かパスワードが違います。保存していません。');
  }
  if (!response.ok) {
    throw new CliError(
      response.data.message ?? `管理画面がエラーを返しました（HTTP ${response.status}）。`,
    );
  }
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600); // 既にあったファイルは mode が変わらないため
  console.log(`保存しました: ${path}（${credentials.adminUrl} に ${credentials.username} として）`);
}

const USAGE = `使い方:
  node nakamaba.mjs login                    管理画面の URL・ユーザー名・パスワードを保存する（本人が実行する）
  node nakamaba.mjs list                     公開中のページと使用量を表示する
  node nakamaba.mjs publish [フォルダ] [--name <ページ名>] [--overwrite]
                                             フォルダを公開する。2 回目からは nakamaba.json のページ名を更新する
  node nakamaba.mjs preview [フォルダ] [--name <ページ名>] [--port <番号>]
                                             公開の前に、手元で公開後と同じ URL の形で開く。何も送らない

環境変数 NAKAMABA_AUTHORIZATION があると、login で保存したファイルの代わりに、その値（「Basic …」）を
管理画面への認証に使う（AI エージェントのサンドボックスなど、本人が login を実行できない環境向け）。
このときは、管理画面の URL を NAKAMABA_ADMIN_URL で指定する。`;

const COMMANDS = { login, list, publish, preview };

const [command, ...rest] = process.argv.slice(2);
const run = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : null;
if (!run) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    await run(rest);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
    } else if (error.code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`${error.message}\n\n${USAGE}`);
    } else {
      throw error;
    }
    process.exitCode = 1;
  }
}
