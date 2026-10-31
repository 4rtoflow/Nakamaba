import { marked, type Tokens } from 'marked';
import type { OutputFile } from './deps.ts';
import { escapeHtml, htmlToPlainText } from './html.ts';
import { HttpError } from './http.ts';
import { contentTypeFor } from './mime.ts';
import type { ZipFile } from './zip.ts';

export interface BuiltPage {
  files: OutputFile[];
  title: string;
  hasThumbnail: boolean;
}

const MARKDOWN_STYLE = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #141414; font: 16px/1.7 -apple-system, "Hiragino Sans", "Noto Sans JP", "Helvetica Neue", Arial, sans-serif; }
main { box-sizing: border-box; max-width: 760px; margin: 0 auto; padding: 48px 24px 80px; overflow-wrap: anywhere; }
h1, h2, h3, h4 { line-height: 1.3; margin: 2em 0 .6em; }
h1:first-child { margin-top: 0; }
img, video { max-width: 100%; height: auto; }
pre { background: #f3f3f3; border-radius: 16px; padding: 16px; overflow-x: auto; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em; }
blockquote { border-left: 3px solid #e0e0e0; color: #707070; margin-left: 0; padding-left: 16px; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid #e0e0e0; padding: 6px 12px; }
a { color: inherit; }
`;

function isRelativeMarkdownLink(href: string): boolean {
  return /^(?![a-z][a-z0-9+.-]*:|\/\/|#)[^?#]*\.md(?:[?#].*)?$/i.test(href);
}

function renderMarkdown(source: string): string {
  return marked.parse(source, {
    async: false,
    gfm: true,
    walkTokens(token) {
      if (token.type === 'link') {
        const link = token as Tokens.Link;
        if (isRelativeMarkdownLink(link.href)) {
          link.href = link.href.replace(/\.md(?=$|[?#])/i, '.html');
        }
      }
    },
  });
}

function markdownTitle(source: string): string | null {
  for (const token of marked.lexer(source)) {
    if (token.type === 'heading') {
      const inline = marked.parseInline((token as Tokens.Heading).text, { async: false });
      const title = htmlToPlainText(inline);
      if (title) return title;
    }
  }
  return null;
}

function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match?.[1]) return null;
  return htmlToPlainText(match[1]) || null;
}

function wrapMarkdown(source: string, fallbackTitle: string): string {
  const title = markdownTitle(source) ?? fallbackTitle;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${MARKDOWN_STYLE}</style>
</head>
<body>
<main>
${renderMarkdown(source)}
</main>
</body>
</html>
`;
}

function outputPathFor(path: string): string {
  return path.replace(/\.md$/i, '.html');
}

/** 展開した zip から、S3 に置くファイルとカードの情報を作る */
export function buildPage(files: ZipFile[], pageName: string): BuiltPage {
  const paths = new Set(files.map((file) => file.path));
  if (!paths.has('index.html') && !paths.has('index.md')) {
    throw new HttpError(
      400,
      'missing_index',
      'zip の直下に index.html か index.md が必要です。フォルダごと圧縮していないか確かめてください。',
    );
  }

  const output = new Map<string, OutputFile>();
  for (const file of files) {
    const path = outputPathFor(file.path);
    if (output.has(path)) {
      throw new HttpError(400, 'path_conflict', `Markdown を変換すると同じパスになります: ${path}`);
    }
    if (/\.md$/i.test(file.path)) {
      const fallback = file.path === 'index.md' ? pageName : file.path;
      const html = wrapMarkdown(file.body.toString('utf8'), fallback);
      output.set(path, {
        path,
        body: Buffer.from(html, 'utf8'),
        contentType: contentTypeFor(path),
      });
    } else {
      output.set(path, { path, body: file.body, contentType: contentTypeFor(path) });
    }
  }

  const index = files.find((file) => file.path === 'index.html');
  const markdownIndex = files.find((file) => file.path === 'index.md');
  const title =
    (index ? htmlTitle(index.body.toString('utf8')) : null) ??
    (markdownIndex ? markdownTitle(markdownIndex.body.toString('utf8')) : null) ??
    pageName;

  return { files: [...output.values()], title, hasThumbnail: paths.has('thumbnail.png') };
}
