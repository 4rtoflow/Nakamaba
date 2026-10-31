import { randomBytes } from 'node:crypto';
import { CloudFrontClient, CreateDistributionCommand } from '@aws-sdk/client-cloudfront';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import type { AwsConfig } from '../../src/app/aws.ts';

/** AWS SDK の接続先を moto に向ける。実際の AWS へは接続しない。 */
export function pointAwsSdkAt(endpoint: string): void {
  Object.assign(process.env, {
    AWS_ENDPOINT_URL: endpoint,
    AWS_REGION: 'ap-northeast-1',
    AWS_ACCESS_KEY_ID: 'testing',
    AWS_SECRET_ACCESS_KEY: 'testing',
    AWS_SESSION_TOKEN: 'testing',
    AWS_EC2_METADATA_DISABLED: 'true',
  });
  // 手元のプロファイルを読まないようにする
  delete process.env.AWS_PROFILE;
}

async function createTable(dynamodb: DynamoDBClient, name: string): Promise<void> {
  await dynamodb.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'name', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'name', KeyType: 'HASH' }],
    }),
  );
}

/** CDK の構成と同じ形のテーブルとバケットを moto に作る */
export async function provisionLocalAws(
  endpoint: string,
  options: { publicBaseUrl: string; adminOrigin?: string },
): Promise<AwsConfig> {
  pointAwsSdkAt(endpoint);
  const suffix = randomBytes(4).toString('hex');
  const dynamodb = new DynamoDBClient({});
  const s3 = new S3Client({ forcePathStyle: true });
  const cloudFront = new CloudFrontClient({});

  const usersTable = `users-${suffix}`;
  const pagesTable = `pages-${suffix}`;
  const siteBucket = `site-${suffix}`;
  const uploadBucket = `upload-${suffix}`;

  await createTable(dynamodb, usersTable);
  await createTable(dynamodb, pagesTable);
  for (const bucket of [siteBucket, uploadBucket]) {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: { LocationConstraint: 'ap-northeast-1' },
      }),
    );
  }
  if (options.adminOrigin) {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: uploadBucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedMethods: ['POST'],
              AllowedOrigins: [options.adminOrigin],
              AllowedHeaders: ['*'],
            },
          ],
        },
      }),
    );
  }

  const distribution = await cloudFront.send(
    new CreateDistributionCommand({
      DistributionConfig: {
        CallerReference: suffix,
        Comment: 'test',
        Enabled: true,
        Origins: {
          Quantity: 1,
          Items: [
            {
              Id: 'site',
              DomainName: `${siteBucket}.s3.amazonaws.com`,
              S3OriginConfig: { OriginAccessIdentity: '' },
            },
          ],
        },
        DefaultCacheBehavior: {
          TargetOriginId: 'site',
          ViewerProtocolPolicy: 'redirect-to-https',
          CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
        },
      },
    }),
  );

  return {
    usersTable,
    pagesTable,
    siteBucket,
    uploadBucket,
    distributionId: distribution.Distribution?.Id ?? '',
    publicBaseUrl: options.publicBaseUrl,
    uploadOrigin: endpoint,
    parameterPrefix: `/nakamaba-${suffix}`,
    forcePathStyle: true,
  };
}
