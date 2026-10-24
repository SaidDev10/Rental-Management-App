import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const endpoint = process.env.DYNAMODB_ENDPOINT;

if (!endpoint) {
  throw new Error('Set DYNAMODB_ENDPOINT to a local DynamoDB endpoint before running integration tests.');
}

const endpointUrl = new URL(endpoint);

if (!['localhost', '127.0.0.1', '[::1]'].includes(endpointUrl.hostname)) {
  throw new Error('Integration tests are restricted to a local DynamoDB endpoint.');
}

const result = spawnSync(
  process.execPath,
  [resolve('node_modules/vitest/vitest.mjs'), 'run', 'test/integration/dynamodb-access-patterns.test.ts'],
  { stdio: 'inherit', env: process.env },
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
