import {
  DEFAULT_LIMITS,
  type Deps,
  type NewPageNotice,
  type Page,
  type PageClaim,
  type PageClaimResult,
  type User,
} from '../../src/app/deps.ts';
import { hashPassword } from '../../src/app/passwords.ts';

export const TEST_UPLOAD_ID = '11111111-2222-4333-8444-555555555555';

export interface FakeWorld {
  deps: Deps;
  users: Map<string, User>;
  pages: Map<string, Page>;
  siteFiles: Map<string, { body: Buffer; contentType: string }>;
  putOrder: string[];
  uploads: Map<string, Buffer>;
  passwords: Map<string, string>;
  invalidations: string[][];
  notices: NewPageNotice[];
  logs: Array<{ message: string; detail?: unknown }>;
  addUser(name: string, role?: User['role'], password?: string): User;
  failSiteFilePut: { key: string | null };
}

export function createFakeWorld(overrides: Partial<Deps> = {}): FakeWorld {
  const users = new Map<string, User>();
  const pages = new Map<string, Page>();
  const siteFiles = new Map<string, { body: Buffer; contentType: string }>();
  const uploads = new Map<string, Buffer>();
  const passwords = new Map<string, string>();
  const invalidations: string[][] = [];
  const notices: NewPageNotice[] = [];
  const logs: Array<{ message: string; detail?: unknown }> = [];
  const putOrder: string[] = [];
  const failSiteFilePut = { key: null as string | null };

  const deps: Deps = {
    users: {
      get: async (name) => users.get(name) ?? null,
      list: async () => [...users.values()],
      create: async (user) => {
        if (users.has(user.name)) return false;
        users.set(user.name, user);
        return true;
      },
      setPasswordHash: async (name, passwordHash) => {
        const user = users.get(name);
        if (!user) return false;
        users.set(name, { ...user, passwordHash });
        return true;
      },
      delete: async (name) => {
        users.delete(name);
      },
    },
    pages: {
      get: async (name) => pages.get(name) ?? null,
      list: async () => [...pages.values()],
      claim: async (claim: PageClaim): Promise<PageClaimResult> => {
        const previous = pages.get(claim.name);
        if (previous && !claim.overrideOwner && previous.owner !== claim.actor) {
          return { claimed: false };
        }
        const page: Page = {
          name: claim.name,
          owner: previous?.owner ?? claim.actor,
          title: claim.title,
          hasThumbnail: claim.hasThumbnail,
          createdAt: previous?.createdAt ?? claim.now,
          updatedAt: claim.now,
        };
        pages.set(claim.name, page);
        return { claimed: true, page, isNew: previous === undefined };
      },
      delete: async (name) => {
        pages.delete(name);
      },
    },
    siteFiles: {
      put: async (key, body, contentType) => {
        if (failSiteFilePut.key === key) throw new Error('S3 に書けません');
        putOrder.push(key);
        siteFiles.set(key, { body: Buffer.from(body), contentType });
      },
      list: async (prefix) => [...siteFiles.keys()].filter((key) => key.startsWith(prefix)),
      totalBytes: async (prefix) =>
        [...siteFiles.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .reduce((sum, [, file]) => sum + file.body.length, 0),
      delete: async (keys) => {
        for (const key of keys) siteFiles.delete(key);
      },
    },
    uploads: {
      createPresignedUpload: async (key, maxBytes, expiresSeconds) => ({
        url: 'https://uploads.example.invalid/',
        fields: { key, maxBytes: String(maxBytes), expiresSeconds: String(expiresSeconds) },
      }),
      size: async (key) => uploads.get(key)?.length ?? null,
      read: async (key) => {
        const value = uploads.get(key);
        if (!value) throw new Error(`no upload ${key}`);
        return value;
      },
      delete: async (key) => {
        uploads.delete(key);
      },
    },
    cdn: {
      invalidate: async (paths) => {
        invalidations.push(paths);
      },
    },
    secrets: {
      getPassword: async (user) => passwords.get(user) ?? null,
      putPassword: async (user, password) => {
        passwords.set(user, password);
      },
      deletePassword: async (user) => {
        passwords.delete(user);
      },
      getDiscordWebhookUrl: async () => null,
    },
    notifier: {
      notifyNewPage: async (notice) => {
        notices.push(notice);
      },
    },
    limits: DEFAULT_LIMITS,
    publicBaseUrl: 'https://public.example.invalid',
    uploadOrigin: 'https://uploads.example.invalid',
    now: () => new Date('2026-11-01T03:00:00.000Z'),
    newId: () => TEST_UPLOAD_ID,
    log: (message, detail) => {
      logs.push({ message, detail });
    },
    ...overrides,
  };

  return {
    deps,
    users,
    pages,
    siteFiles,
    putOrder,
    uploads,
    passwords,
    invalidations,
    notices,
    logs,
    failSiteFilePut,
    addUser(name, role = 'member', password = `${name}-password`) {
      const user: User = {
        name,
        role,
        passwordHash: hashPassword(password),
        createdAt: '2026-10-01T00:00:00.000Z',
      };
      users.set(name, user);
      passwords.set(name, password);
      return user;
    },
  };
}

export function basicHeader(username: string, password = `${username}-password`): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}
