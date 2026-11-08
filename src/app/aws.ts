import { randomUUID } from 'node:crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import {
  type AgentToken,
  type Cdn,
  DEFAULT_LIMITS,
  type Deps,
  type Page,
  type PageClaimResult,
  type PageStore,
  type Secrets,
  type SiteFiles,
  type TokenStore,
  type Uploads,
  type User,
  type UserStore,
} from './deps.ts';
import { createDiscordNotifier } from './discord.ts';

export interface AwsConfig {
  usersTable: string;
  pagesTable: string;
  tokensTable: string;
  siteBucket: string;
  uploadBucket: string;
  distributionId: string;
  publicBaseUrl: string;
  uploadOrigin: string;
  parameterPrefix: string;
  /** moto で動かすときだけ true */
  forcePathStyle: boolean;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`環境変数 ${name} がありません`);
  return value;
}

export function configFromEnv(env: NodeJS.ProcessEnv): AwsConfig {
  return {
    usersTable: requireEnv(env, 'USERS_TABLE'),
    pagesTable: requireEnv(env, 'PAGES_TABLE'),
    tokensTable: requireEnv(env, 'TOKENS_TABLE'),
    siteBucket: requireEnv(env, 'SITE_BUCKET'),
    uploadBucket: requireEnv(env, 'UPLOAD_BUCKET'),
    distributionId: requireEnv(env, 'DISTRIBUTION_ID'),
    publicBaseUrl: requireEnv(env, 'PUBLIC_BASE_URL'),
    uploadOrigin: requireEnv(env, 'UPLOAD_ORIGIN'),
    parameterPrefix: requireEnv(env, 'PARAMETER_PREFIX'),
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  };
}

async function scanAll<T>(documents: DynamoDBDocumentClient, tableName: string): Promise<T[]> {
  const items: T[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await documents.send(
      new ScanCommand({ TableName: tableName, ExclusiveStartKey: startKey }),
    );
    items.push(...((result.Items ?? []) as T[]));
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export function createUserStore(documents: DynamoDBDocumentClient, tableName: string): UserStore {
  return {
    async get(name) {
      const result = await documents.send(new GetCommand({ TableName: tableName, Key: { name } }));
      return (result.Item as User | undefined) ?? null;
    },
    list: () => scanAll<User>(documents, tableName),
    async create(user) {
      try {
        await documents.send(
          new PutCommand({
            TableName: tableName,
            Item: user,
            ConditionExpression: 'attribute_not_exists(#name)',
            ExpressionAttributeNames: { '#name': 'name' },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },
    async setPasswordHash(name, passwordHash) {
      try {
        await documents.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { name },
            UpdateExpression: 'SET passwordHash = :hash',
            ConditionExpression: 'attribute_exists(#name)',
            ExpressionAttributeNames: { '#name': 'name' },
            ExpressionAttributeValues: { ':hash': passwordHash },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },
    async delete(name) {
      await documents.send(new DeleteCommand({ TableName: tableName, Key: { name } }));
    },
  };
}

export function createPageStore(documents: DynamoDBDocumentClient, tableName: string): PageStore {
  return {
    async get(name) {
      const result = await documents.send(new GetCommand({ TableName: tableName, Key: { name } }));
      return (result.Item as Page | undefined) ?? null;
    },
    list: () => scanAll<Page>(documents, tableName),
    async claim(claim): Promise<PageClaimResult> {
      try {
        const result = await documents.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { name: claim.name },
            // パスワードで公開・更新したら、前にトークンで更新した記録を消す
            UpdateExpression: `SET #owner = if_not_exists(#owner, :actor), createdAt = if_not_exists(createdAt, :now), title = :title, hasThumbnail = :thumbnail, updatedAt = :now${claim.tokenLabel === null ? ' REMOVE updatedWithToken' : ', updatedWithToken = :token'}`,
            ...(claim.overrideOwner
              ? {}
              : { ConditionExpression: 'attribute_not_exists(#owner) OR #owner = :actor' }),
            ExpressionAttributeNames: { '#owner': 'owner' },
            ExpressionAttributeValues: {
              ':actor': claim.actor,
              ':now': claim.now,
              ':title': claim.title,
              ':thumbnail': claim.hasThumbnail,
              ...(claim.tokenLabel === null ? {} : { ':token': claim.tokenLabel }),
            },
            ReturnValues: 'ALL_OLD',
          }),
        );
        const previous = result.Attributes as Page | undefined;
        return {
          claimed: true,
          isNew: previous === undefined,
          page: {
            name: claim.name,
            owner: previous?.owner ?? claim.actor,
            title: claim.title,
            hasThumbnail: claim.hasThumbnail,
            createdAt: previous?.createdAt ?? claim.now,
            updatedAt: claim.now,
            ...(claim.tokenLabel === null ? {} : { updatedWithToken: claim.tokenLabel }),
          },
        };
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return { claimed: false };
        throw error;
      }
    },
    async delete(name) {
      await documents.send(new DeleteCommand({ TableName: tableName, Key: { name } }));
    },
  };
}

export function createTokenStore(documents: DynamoDBDocumentClient, tableName: string): TokenStore {
  return {
    async get(hash) {
      // 取り消した直後のトークンを通さないよう、強い整合性で読む
      const result = await documents.send(
        new GetCommand({ TableName: tableName, Key: { hash }, ConsistentRead: true }),
      );
      return (result.Item as AgentToken | undefined) ?? null;
    },
    list: () => scanAll<AgentToken>(documents, tableName),
    async create(token) {
      await documents.send(
        new PutCommand({
          TableName: tableName,
          Item: token,
          ConditionExpression: 'attribute_not_exists(#hash)',
          ExpressionAttributeNames: { '#hash': 'hash' },
        }),
      );
    },
    async touch(hash, lastUsedAt) {
      try {
        await documents.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { hash },
            UpdateExpression: 'SET lastUsedAt = :now',
            // 取り消したトークンを書き戻さない
            ConditionExpression: 'attribute_exists(#hash)',
            ExpressionAttributeNames: { '#hash': 'hash' },
            ExpressionAttributeValues: { ':now': lastUsedAt },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    },
    async delete(hash) {
      await documents.send(new DeleteCommand({ TableName: tableName, Key: { hash } }));
    },
  };
}

export function createSiteFiles(s3: S3Client, bucket: string): SiteFiles {
  return {
    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async list(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const result = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of result.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        token = result.NextContinuationToken;
      } while (token);
      return keys;
    },
    async totalBytes(prefix) {
      let total = 0;
      let token: string | undefined;
      do {
        const result = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of result.Contents ?? []) total += object.Size ?? 0;
        token = result.NextContinuationToken;
      } while (token);
      return total;
    },
    async delete(keys) {
      for (let start = 0; start < keys.length; start += 1000) {
        const batch = keys.slice(start, start + 1000);
        const result = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (result.Errors?.length) {
          throw new Error(`S3 の削除に失敗しました: ${result.Errors.length} 件`);
        }
      }
    },
  };
}

function isNotFound(error: unknown): boolean {
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === 'NotFound' || name === 'NoSuchKey' || $metadata?.httpStatusCode === 404;
}

export function createUploads(s3: S3Client, bucket: string): Uploads {
  return {
    async createPresignedUpload(key, maxBytes, expiresSeconds) {
      const { url, fields } = await createPresignedPost(s3, {
        Bucket: bucket,
        Key: key,
        Conditions: [['content-length-range', 1, maxBytes]],
        Expires: expiresSeconds,
      });
      return { url, fields };
    },
    async size(key) {
      try {
        const result = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return result.ContentLength ?? 0;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async read(key) {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!result.Body) throw new Error('S3 の応答に本文がありません');
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export function createCdn(
  cloudFront: CloudFrontClient,
  distributionId: string,
  newId: () => string,
): Cdn {
  return {
    async invalidate(paths) {
      await cloudFront.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: {
            CallerReference: newId(),
            Paths: { Quantity: paths.length, Items: paths },
          },
        }),
      );
    },
  };
}

export function createSecrets(ssm: SSMClient, prefix: string): Secrets {
  const passwordName = (user: string) => `${prefix}/users/${user}/password`;
  const read = async (name: string): Promise<string | null> => {
    try {
      const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return result.Parameter?.Value ?? null;
    } catch (error) {
      if (error instanceof ParameterNotFound) return null;
      throw error;
    }
  };
  return {
    getPassword: (user) => read(passwordName(user)),
    async putPassword(user, password) {
      await ssm.send(
        new PutParameterCommand({
          Name: passwordName(user),
          Value: password,
          Type: 'SecureString',
          Tier: 'Standard',
          Overwrite: true,
        }),
      );
    },
    async deletePassword(user) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: passwordName(user) }));
      } catch (error) {
        if (!(error instanceof ParameterNotFound)) throw error;
      }
    },
    getDiscordWebhookUrl: () => read(`${prefix}/discord-webhook-url`),
  };
}

export function createAwsDeps(config: AwsConfig, overrides: Partial<Deps> = {}): Deps {
  const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = new S3Client({ forcePathStyle: config.forcePathStyle });
  const ssm = new SSMClient({});
  const cloudFront = new CloudFrontClient({});
  const secrets = createSecrets(ssm, config.parameterPrefix);
  const log = (message: string, detail?: unknown) => {
    console.error(JSON.stringify({ message, detail }));
  };
  return {
    users: createUserStore(documents, config.usersTable),
    pages: createPageStore(documents, config.pagesTable),
    tokens: createTokenStore(documents, config.tokensTable),
    siteFiles: createSiteFiles(s3, config.siteBucket),
    uploads: createUploads(s3, config.uploadBucket),
    cdn: createCdn(cloudFront, config.distributionId, randomUUID),
    secrets,
    notifier: createDiscordNotifier({
      getWebhookUrl: () => secrets.getDiscordWebhookUrl(),
      fetch,
      log,
    }),
    limits: DEFAULT_LIMITS,
    publicBaseUrl: config.publicBaseUrl,
    uploadOrigin: config.uploadOrigin,
    now: () => new Date(),
    newId: randomUUID,
    log,
    ...overrides,
  };
}
