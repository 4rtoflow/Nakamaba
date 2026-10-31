import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { NakamabaStack } from '../../infra/stack.ts';

let template: Template;

function synth(reservedConcurrency: number | undefined): Template {
  const stack = new NakamabaStack(new App(), 'Test', {
    env: { region: 'ap-northeast-1', account: '111111111111' },
    reservedConcurrency,
  });
  return Template.fromStack(stack);
}

beforeAll(() => {
  template = synth(5);
});

function policyStatements(): Array<{ Action: string | string[]; Resource: unknown }> {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement,
  );
}

function actions(statement: { Action: string | string[] }): string[] {
  return Array.isArray(statement.Action) ? statement.Action : [statement.Action];
}

describe('S3', () => {
  it('公開ページと zip の置き場所を分け、どちらも外部から直接読めない', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(2);
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('zip は 1 日で消え、関数 URL のオリジンからの POST だけを許可する', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: [{ ExpirationInDays: 1, Status: 'Enabled' }] },
      CorsConfiguration: {
        CorsRules: [
          {
            AllowedMethods: ['POST'],
            AllowedOrigins: [
              { 'Fn::Join': ['', ['https://*.lambda-url.', { Ref: 'AWS::Region' }, '.on.aws']] },
            ],
          },
        ],
      },
    });
  });

  it('公開ページの S3 は CloudFront の OAC からだけ読める', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
          }),
        ]),
      },
    });
  });
});

describe('CloudFront', () => {
  it('HTTPS へ転送し、書き換えの関数と 404 のページを使う', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          ViewerProtocolPolicy: 'redirect-to-https',
          AllowedMethods: ['GET', 'HEAD'],
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        },
        CustomErrorResponses: [
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: '/404.html',
          }),
        ],
      },
    });
  });

  it('書き換えの関数は JavaScript runtime 2.0 で動く', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      FunctionConfig: { Runtime: 'cloudfront-js-2.0' },
    });
  });
});

describe('Lambda', () => {
  it('関数 URL は Lambda の中で認証し、CORS を許可しない', () => {
    const urls = template.findResources('AWS::Lambda::Url');
    const [url] = Object.values(urls);
    expect(url?.Properties.AuthType).toBe('NONE');
    expect(url?.Properties.Cors).toBeUndefined();
  });

  it('関数 URL からだけ呼べるよう、2 つの権限を与える', () => {
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunctionUrl',
      Principal: '*',
      FunctionUrlAuthType: 'NONE',
    });
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: '*',
      InvokedViaFunctionUrl: true,
    });
  });

  it('Node.js 24 で動き、公開の処理に足りる時間を持つ', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Timeout: 120,
      MemorySize: 1024,
      Environment: {
        Variables: Match.objectLike({
          PARAMETER_PREFIX: '/nakamaba',
          USERS_TABLE: Match.anyValue(),
          PAGES_TABLE: Match.anyValue(),
          SITE_BUCKET: Match.anyValue(),
          UPLOAD_BUCKET: Match.anyValue(),
          DISTRIBUTION_ID: Match.anyValue(),
          PUBLIC_BASE_URL: Match.anyValue(),
          UPLOAD_ORIGIN: Match.anyValue(),
        }),
      },
    });
  });

  it('同時実行数の上限を設定する', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 5,
    });
  });

  it('上限は外せる', () => {
    const functions = synth(undefined).findResources('AWS::Lambda::Function');
    for (const fn of Object.values(functions)) {
      expect(fn.Properties.ReservedConcurrentExecutions).toBeUndefined();
    }
  });

  it('環境変数に秘密を置かない', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const text = JSON.stringify(functions);
    expect(text).not.toMatch(/discord\.com|WEBHOOK|PASSWORD/i);
  });
});

describe('IAM', () => {
  it('Parameter Store は /nakamaba の下だけに限る', () => {
    const statements = policyStatements().filter((statement) =>
      actions(statement).some((action) => action.startsWith('ssm:')),
    );
    expect(statements).toHaveLength(1);
    expect(JSON.stringify(statements[0]?.Resource)).toContain('parameter/nakamaba/*');
  });

  it('invalidation はこの配信だけに限る', () => {
    const [statement] = policyStatements().filter((item) =>
      actions(item).includes('cloudfront:CreateInvalidation'),
    );
    expect(statement).toBeDefined();
    expect(JSON.stringify(statement?.Resource)).toContain('distribution/');
    expect(statement?.Resource).not.toBe('*');
  });

  it('全リソースへの権限を与えない', () => {
    expect(policyStatements().filter((statement) => statement.Resource === '*')).toEqual([]);
  });
});

describe('DynamoDB', () => {
  it('ユーザーとページを name をキーにした従量課金の表に置く', () => {
    const tables = Object.values(template.findResources('AWS::DynamoDB::Table'));
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
      expect(table.Properties.KeySchema).toEqual([{ AttributeName: 'name', KeyType: 'HASH' }]);
    }
  });
});

describe('出力', () => {
  it('公開の URL と管理画面の URL を出す', () => {
    const outputs = Object.keys(template.findOutputs('*'));
    expect(outputs).toEqual(expect.arrayContaining(['PublicUrl', 'AdminUrl']));
  });
});
