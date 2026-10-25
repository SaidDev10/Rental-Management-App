import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const expectedStage = 'dev';
const expectedTableName = `rental-app-${expectedStage}-db`;

const getErrorCode = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } };

  return body.error?.code;
};

if (process.env.RUN_LIVE_AUTH_INTEGRATION !== 'true') {
  throw new Error('Set RUN_LIVE_AUTH_INTEGRATION=true to run the live auth integration check.');
}

if (process.env.ALLOW_LIVE_AUTH_WRITES !== 'true') {
  throw new Error('Set ALLOW_LIVE_AUTH_WRITES=true to permit the test account and session writes in dev DynamoDB.');
}

if (process.env.STAGE !== expectedStage) {
  throw new Error(`STAGE must be ${expectedStage} for the live auth integration check.`);
}

if (process.env.TABLE_NAME !== expectedTableName) {
  throw new Error(`TABLE_NAME must be ${expectedTableName} for the live auth integration check.`);
}

if (process.env.AWS_REGION !== 'eu-north-1') {
  throw new Error('AWS_REGION must be eu-north-1 for the live auth integration check.');
}

if (!process.env.SSM_PARAM_PREFIX) {
  throw new Error('SSM_PARAM_PREFIX must identify the dev JWT keys in SSM.');
}

if (
  process.env.AWS_ACCESS_KEY_ID === 'test' ||
  process.env.AWS_SECRET_ACCESS_KEY === 'test'
) {
  throw new Error('LocalStack test credentials are not allowed for the live auth integration check.');
}

delete process.env.AWS_ENDPOINT_URL;
delete process.env.AWS_ENDPOINT_URL_DYNAMODB;
delete process.env.AWS_ENDPOINT_URL_SSM;

process.env.USE_DYNAMO_AUTH = 'true';
process.env.USE_SSM_JWT_KEYS = 'true';
delete process.env.JWT_PRIVATE_KEY;
delete process.env.JWT_PUBLIC_KEY;

const main = async (): Promise<void> => {
  const [{ app }, { getDocumentClient }, { pk, sk }, { hashRefreshToken, verifyAccessToken }] = await Promise.all([
    import('../src/app'),
    import('../src/shared/db'),
    import('../src/shared/db/keys'),
    import('../src/modules/auth/tokens'),
  ]);

  const tableName = process.env.TABLE_NAME!;
  const email = `auth-live-${randomUUID()}@example.test`;
  const password = `Integration-${randomUUID()}-Aa1`;
  let accountId: string | undefined;
  let userId: string | undefined;
  let replayedSessionId: string | undefined;
  const issuedRefreshTokens: string[] = [];

  try {
    const registerResponse = await app.request('http://localhost/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountName: 'Live Auth Integration',
        ownerName: 'Integration Test',
        email,
        password,
        phone: '+212600000000',
        locale: 'en',
      }),
    });
    if (registerResponse.status !== 201) {
      throw new Error(`Registration failed with HTTP ${registerResponse.status}.`);
    }
    const registration = (await registerResponse.json()) as {
      account: { id: string };
      user: { id: string };
    };
    accountId = registration.account.id;
    userId = registration.user.id;

    const loginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (loginResponse.status !== 200) {
      throw new Error(`Login failed with HTTP ${loginResponse.status}.`);
    }
    const login = (await loginResponse.json()) as { accessToken: string; refreshToken: string };
    issuedRefreshTokens.push(login.refreshToken);
    replayedSessionId = (await verifyAccessToken(login.accessToken)).sid;

    const refreshResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    if (refreshResponse.status !== 200) {
      throw new Error(`Refresh rotation failed with HTTP ${refreshResponse.status}.`);
    }
    const refresh = (await refreshResponse.json()) as { accessToken: string; refreshToken: string };
    issuedRefreshTokens.push(refresh.refreshToken);

    const invalidRefreshResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: `invalid-${randomUUID()}` }),
    });
    if (invalidRefreshResponse.status !== 401 || (await getErrorCode(invalidRefreshResponse)) !== 'INVALID_REFRESH') {
      throw new Error(`Unrecognized refresh token returned HTTP ${invalidRefreshResponse.status}; expected INVALID_REFRESH.`);
    }

    const refreshAfterInvalidTokenResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh.refreshToken }),
    });
    if (refreshAfterInvalidTokenResponse.status !== 200) {
      throw new Error(`An unrecognized token unexpectedly invalidated the active session (HTTP ${refreshAfterInvalidTokenResponse.status}).`);
    }
    const refreshAfterInvalidToken = (await refreshAfterInvalidTokenResponse.json()) as {
      accessToken: string;
      refreshToken: string;
    };
    issuedRefreshTokens.push(refreshAfterInvalidToken.refreshToken);

    const oldTokenReplayResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: login.refreshToken }),
    });
    if (oldTokenReplayResponse.status !== 401 || (await getErrorCode(oldTokenReplayResponse)) !== 'SESSION_REVOKED') {
      throw new Error(`Rotated refresh-token replay did not revoke the session (HTTP ${oldTokenReplayResponse.status}).`);
    }

    const revokedSessionRefreshResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshAfterInvalidToken.refreshToken }),
    });
    if (revokedSessionRefreshResponse.status !== 401) {
      throw new Error(`Replay did not revoke the active refresh token (HTTP ${revokedSessionRefreshResponse.status}).`);
    }

    const secondLoginResponse = await app.request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (secondLoginResponse.status !== 200) {
      throw new Error(`Second login failed with HTTP ${secondLoginResponse.status}.`);
    }
    const secondLogin = (await secondLoginResponse.json()) as { accessToken: string; refreshToken: string };
    issuedRefreshTokens.push(secondLogin.refreshToken);
    if ((await verifyAccessToken(secondLogin.accessToken)).sid === replayedSessionId) {
      throw new Error('A new login reused the prior session ID.');
    }

    const logoutResponse = await app.request('http://localhost/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secondLogin.accessToken}` },
    });
    if (logoutResponse.status !== 204) {
      throw new Error(`Logout failed with HTTP ${logoutResponse.status}.`);
    }

    const revokedTokenReplayResponse = await app.request('http://localhost/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: secondLogin.refreshToken }),
    });
    if (revokedTokenReplayResponse.status !== 401 || (await getErrorCode(revokedTokenReplayResponse)) !== 'SESSION_REVOKED') {
      throw new Error(`Revoked refresh-token replay returned HTTP ${revokedTokenReplayResponse.status}, expected SESSION_REVOKED.`);
    }

    process.stdout.write('Live auth integration passed: registration, login, refresh rotation, logout, and replay rejection.\n');
  } finally {
    if (accountId && userId) {
      const client = getDocumentClient();
      const keys: Array<{ PK: string; SK: string }> = [
        { PK: 'SYSTEM', SK: `EMAIL#${email}` },
        { PK: pk.account(accountId), SK: sk.meta() },
        { PK: pk.account(accountId), SK: sk.user(userId) },
        { PK: pk.session(userId), SK: sk.active() },
      ];
      for (const refreshToken of issuedRefreshTokens) {
        keys.push({
          PK: pk.session(userId),
          SK: sk.usedRefreshToken(hashRefreshToken(refreshToken)),
        });
      }

      if (replayedSessionId) {
        const auditItems = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': pk.audit(accountId) },
          }),
        );
        for (const item of auditItems.Items ?? []) {
          if (item.action === 'AUTH_REFRESH_TOKEN_REUSE' && item.targetId === replayedSessionId) {
            keys.push({ PK: String(item.PK), SK: String(item.SK) });
          }
        }
      }

      await Promise.all(
        keys.map((Key) => client.send(new DeleteCommand({ TableName: tableName, Key }))),
      );
    }
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Live auth integration failed.'}\n`);
  process.exitCode = 1;
});
