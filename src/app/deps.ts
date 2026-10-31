export type Role = 'admin' | 'member';

export interface User {
  name: string;
  role: Role;
  passwordHash: string;
  createdAt: string;
}

export interface Page {
  name: string;
  owner: string;
  title: string;
  hasThumbnail: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserStore {
  get(name: string): Promise<User | null>;
  list(): Promise<User[]>;
  /** 同じ名前が既にあれば false を返す */
  create(user: User): Promise<boolean>;
  /** ユーザーが居なければ false を返す */
  setPasswordHash(name: string, passwordHash: string): Promise<boolean>;
  delete(name: string): Promise<void>;
}

export interface PageClaim {
  name: string;
  actor: string;
  /** false なら、ページが無いか actor が公開した人のときだけ書き込める */
  overrideOwner: boolean;
  title: string;
  hasThumbnail: boolean;
  now: string;
}

export type PageClaimResult = { claimed: false } | { claimed: true; page: Page; isNew: boolean };

export interface PageStore {
  get(name: string): Promise<Page | null>;
  list(): Promise<Page[]>;
  /** 同じ名前の同時公開でも 1 人だけが通るよう、条件付きで書き込む */
  claim(claim: PageClaim): Promise<PageClaimResult>;
  delete(name: string): Promise<void>;
}

export interface OutputFile {
  path: string;
  body: Buffer;
  contentType: string;
}

export interface SiteFiles {
  put(key: string, body: Buffer | string, contentType: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

export interface Uploads {
  createPresignedUpload(
    key: string,
    maxBytes: number,
    expiresSeconds: number,
  ): Promise<PresignedUpload>;
  /** オブジェクトが無ければ null を返す */
  size(key: string): Promise<number | null>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export interface Cdn {
  invalidate(paths: string[]): Promise<void>;
}

export interface Secrets {
  getPassword(user: string): Promise<string | null>;
  putPassword(user: string, password: string): Promise<void>;
  deletePassword(user: string): Promise<void>;
  getDiscordWebhookUrl(): Promise<string | null>;
}

export interface NewPageNotice {
  title: string;
  owner: string;
  url: string;
}

export interface Notifier {
  notifyNewPage(notice: NewPageNotice): Promise<void>;
}

export interface Limits {
  maxZipBytes: number;
  maxUnzippedBytes: number;
  maxFiles: number;
  uploadExpiresSeconds: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxZipBytes: 50 * 1024 * 1024,
  maxUnzippedBytes: 200 * 1024 * 1024,
  maxFiles: 1000,
  uploadExpiresSeconds: 15 * 60,
};

export interface Deps {
  users: UserStore;
  pages: PageStore;
  siteFiles: SiteFiles;
  uploads: Uploads;
  cdn: Cdn;
  secrets: Secrets;
  notifier: Notifier;
  limits: Limits;
  publicBaseUrl: string;
  /** 管理画面の CSP に載せる、zip の送り先のオリジン */
  uploadOrigin: string;
  now: () => Date;
  newId: () => string;
  log: (message: string, detail?: unknown) => void;
}
