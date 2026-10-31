import { Buffer } from 'node:buffer';
import yauzl from 'yauzl';
import { HttpError } from './http.ts';

export interface ZipLimits {
  maxFiles: number;
  maxUnzippedBytes: number;
}

export interface ZipFile {
  path: string;
  body: Buffer;
}

const MAX_PATH_BYTES = 900;

function invalid(message: string): HttpError {
  return new HttpError(400, 'invalid_zip', message);
}

function assertSafePath(path: string): void {
  const segments = path.split('/');
  const unsafe =
    path.startsWith('/') ||
    path.includes('\\') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くための検査
    /[\u0000-\u001f\u007f]/.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES;
  if (unsafe) throw invalid(`zip の中に使えないパスがあります: ${path}`);
}

function isSymlink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

function isIgnored(path: string): boolean {
  return path.startsWith('__MACOSX/') || path === '.DS_Store' || path.endsWith('/.DS_Store');
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, zipFile) => {
        if (error || !zipFile) reject(invalid(`zip を読めません: ${error?.message ?? '不明'}`));
        else resolve(zipFile);
      },
    );
  });
}

function readEntry(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(invalid(`zip を読めません: ${error?.message ?? '不明'}`));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', (streamError) =>
        reject(invalid(`zip を読めません: ${streamError.message}`)),
      );
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

/** 友人が作った zip を信用せず、パス・種類・サイズを確かめながら展開する */
export async function extractZip(buffer: Buffer, limits: ZipLimits): Promise<ZipFile[]> {
  const zipFile = await openZip(buffer);
  if (zipFile.entryCount > limits.maxFiles * 2) {
    zipFile.close();
    throw invalid(`ファイルが多すぎます（上限 ${limits.maxFiles} 個）。`);
  }

  return new Promise<ZipFile[]>((resolve, reject) => {
    const files: ZipFile[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;

    const fail = (error: unknown) => {
      zipFile.close();
      reject(error instanceof HttpError ? error : invalid(`zip を読めません: ${String(error)}`));
    };

    const handleEntry = async (entry: yauzl.Entry): Promise<void> => {
      const path = entry.fileName;
      const isDirectory = path.endsWith('/');
      assertSafePath(isDirectory ? path.slice(0, -1) : path);
      if (isDirectory || isIgnored(path)) return;
      if (entry.isEncrypted()) throw invalid(`暗号化された zip は使えません: ${path}`);
      if (isSymlink(entry)) throw invalid(`シンボリックリンクは使えません: ${path}`);
      if (seen.has(path)) throw invalid(`同じパスが重複しています: ${path}`);
      seen.add(path);
      if (seen.size > limits.maxFiles) {
        throw invalid(`ファイルが多すぎます（上限 ${limits.maxFiles} 個）。`);
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > limits.maxUnzippedBytes) {
        throw invalid(`展開後のサイズが大きすぎます（上限 ${limits.maxUnzippedBytes} バイト）。`);
      }
      files.push({ path, body: await readEntry(zipFile, entry) });
    };

    zipFile.on('error', (error) => fail(invalid(`zip を読めません: ${error.message}`)));
    zipFile.on('end', () => resolve(files));
    zipFile.on('entry', (entry: yauzl.Entry) => {
      handleEntry(entry).then(() => zipFile.readEntry(), fail);
    });
    zipFile.readEntry();
  });
}
