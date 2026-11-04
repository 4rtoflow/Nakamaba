#!/usr/bin/env node
// Nakamaba の API でフォルダを公開する。依存パッケージを持たない（プラグインはそのまま配られるため）。
import { chmod, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

class CliError extends Error {}

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

async function readCredentials() {
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
      return value;
    }
  } catch {
    // 下で同じエラーにする
  }
  throw askLogin(`${credentialsPath()} の形式が正しくありません。`);
}

async function request(credentials, method, path, body) {
  const token = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  let response;
  try {
    response = await fetch(`${credentials.adminUrl}${path}`, {
      method,
      headers: {
        authorization: `Basic ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new CliError(
      `管理画面に接続できません（${credentials.adminUrl}）: ${error.cause?.message ?? error.message}`,
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
  const response = await request(credentials, method, path, body);
  if (response.status === 401) throw askLogin('ユーザー名かパスワードが違います。');
  if (!response.ok) {
    throw new CliError(
      response.data.message ?? `管理画面がエラーを返しました（HTTP ${response.status}）。`,
    );
  }
  return response.data;
}

/** 公開するファイルを集める。. で始まるもの（.env・.git など）とシンボリックリンクは送らない */
async function collectFiles(root) {
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
        files.push({ path, body: await readFile(full) });
      }
    }
  }

  await walk(root);
  return { files, skipped };
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

async function publish(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: 'string' }, overwrite: { type: 'boolean', default: false } },
    allowPositionals: true,
  });
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
  const name = saved ?? values.name;
  if (!name)
    throw new CliError('ページ名を --name で指定してください。ページ名は URL になります。');
  if (!NAME.test(name)) {
    throw new CliError(
      'ページ名は英小文字・数字・ハイフンだけで、63 文字までです。先頭と末尾にハイフンは使えません。',
    );
  }

  const { files, skipped } = await collectFiles(root);
  if (!files.some((file) => file.path === 'index.html' || file.path === 'index.md')) {
    throw new CliError('フォルダの直下に index.html か index.md が必要です。');
  }

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
    throw new CliError(`zip を送れませんでした: ${error.cause?.message ?? error.message}`);
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
  const { pages, usage } = await api(credentials, 'GET', '/api/pages');
  console.log(
    `${credentials.username} の使用量: ${formatBytes(usage.usedBytes)} / ${formatBytes(usage.maxBytes)}`,
  );
  for (const page of pages) {
    const mine = page.canModify ? '' : '（更新できない）';
    console.log(`${page.name}\t${page.title}\t${page.owner}\t${page.url}${mine}`);
  }
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

  const response = await request(credentials, 'GET', '/api/me');
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
                                             フォルダを公開する。2 回目からは nakamaba.json のページ名を更新する`;

const COMMANDS = { login, list, publish };

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
