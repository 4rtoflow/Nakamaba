import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { configFromEnv, createAwsDeps } from './aws.ts';
import type { Deps } from './deps.ts';
import type { AppRequest } from './http.ts';
import { handleRequest } from './router.ts';

export function toAppRequest(event: LambdaFunctionURLEvent): AppRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return {
    method: event.requestContext.http.method.toUpperCase(),
    path: event.rawPath,
    headers,
    body: event.body
      ? event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body
      : '',
  };
}

let deps: Deps | undefined;

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  deps ??= createAwsDeps(configFromEnv(process.env));
  const response = await handleRequest(deps, toAppRequest(event));
  return { statusCode: response.status, headers: response.headers, body: response.body };
}
