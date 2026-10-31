import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Aws,
  CfnOutput,
  aws_cloudfront as cloudfront,
  Duration,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  aws_cloudfront_origins as origins,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARAMETER_PREFIX = '/nakamaba';

export interface NakamabaStackProps extends StackProps {
  /** Lambda の同時実行数の上限。undefined なら設定しない。 */
  reservedConcurrency?: number | undefined;
}

export class NakamabaStack extends Stack {
  constructor(scope: Construct, id: string, props: NakamabaStackProps) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // 関数 URL のドメインは Lambda を作るまで分からず、Lambda はこのバケットに依存するので、
    // CORS はリージョンの関数 URL 全体で許可する。送信自体は署名付きの条件で守られる。
    const uploadBucket = new s3.Bucket(this, 'UploadBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{ expiration: Duration.days(1) }],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: [`https://*.lambda-url.${Aws.REGION}.on.aws`],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    const usersTable = new dynamodb.Table(this, 'UsersTable', {
      partitionKey: { name: 'name', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const pagesTable = new dynamodb.Table(this, 'PagesTable', {
      partitionKey: { name: 'name', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const rewrite = new cloudfront.Function(this, 'RewriteFunction', {
      code: cloudfront.FunctionCode.fromFile({ filePath: join(ROOT, 'src/edge/rewrite.js') }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Nakamaba public pages',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [
          { function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      // OAC では、S3 に無いファイルへのアクセスが 403 で返る
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.seconds(10),
        },
      ],
    });

    const app = new nodejs.NodejsFunction(this, 'AppFunction', {
      entry: join(ROOT, 'src/app/handler.ts'),
      handler: 'handler',
      projectRoot: ROOT,
      depsLockFilePath: join(ROOT, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(2),
      reservedConcurrentExecutions: props.reservedConcurrency,
      environment: {
        USERS_TABLE: usersTable.tableName,
        PAGES_TABLE: pagesTable.tableName,
        SITE_BUCKET: siteBucket.bucketName,
        UPLOAD_BUCKET: uploadBucket.bucketName,
        DISTRIBUTION_ID: distribution.distributionId,
        PUBLIC_BASE_URL: `https://${distribution.distributionDomainName}`,
        UPLOAD_ORIGIN: `https://${uploadBucket.bucketRegionalDomainName}`,
        PARAMETER_PREFIX,
      },
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        minify: true,
        sourceMap: false,
        // ランタイムに無い @aws-sdk/s3-presigned-post を使うので、SDK ごと同梱する
        bundleAwsSDK: true,
        banner:
          "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -R "${inputDir}/src/app/admin-assets" "${outputDir}/admin-assets"`,
          ],
        },
      },
    });

    // Basic 認証は Lambda の中で確かめる。CORS は許可しない（別オリジンの PUT と DELETE を通さないため）。
    const appUrl = app.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    usersTable.grantReadWriteData(app);
    pagesTable.grantReadWriteData(app);
    siteBucket.grantReadWrite(app);
    siteBucket.grantDelete(app);
    uploadBucket.grantReadWrite(app);
    uploadBucket.grantDelete(app);
    app.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/${distribution.distributionId}`,
        ],
      }),
    );
    app.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [
          `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${PARAMETER_PREFIX}/*`,
        ],
      }),
    );

    new CfnOutput(this, 'PublicUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'AdminUrl', { value: appUrl.url });
    new CfnOutput(this, 'UsersTableName', { value: usersTable.tableName });
    new CfnOutput(this, 'PagesTableName', { value: pagesTable.tableName });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new CfnOutput(this, 'ParameterPrefix', { value: PARAMETER_PREFIX });
  }
}
