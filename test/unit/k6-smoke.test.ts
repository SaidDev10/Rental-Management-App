import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const profileModuleUrl = pathToFileURL(resolve('load/k6-profile.js')).href;
const scenarioPath = resolve('load/k6-smoke.js');

function runNode(source: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `Node exited with ${result.status}`);
  }

  return result.stdout.trim();
}

describe('k6 local smoke/load scenario', () => {
  it('is valid JavaScript that Node can parse before handing it to k6', () => {
    const result = spawnSync(process.execPath, ['--check', scenarioPath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('resolves the smoke and target 100-VU load profiles with latency thresholds', () => {
    const output = runNode(`
      import { resolveProfile, MAX_LOAD_VUS } from ${JSON.stringify(profileModuleUrl)};
      const smoke = resolveProfile('smoke');
      const load = resolveProfile('load');
      console.log(JSON.stringify({ smoke, load, maxVus: MAX_LOAD_VUS }));
    `);
    const { smoke, load, maxVus } = JSON.parse(output);

    const expectedThresholds = {
      http_req_failed: ['rate<0.01'],
      http_req_duration: ['p(95)<400', 'p(99)<1000'],
      checks: ['rate>0.99'],
    };

    expect(smoke).toEqual({ vus: 1, duration: '30s', thresholds: expectedThresholds });
    expect(load).toEqual({
      stages: [
        { duration: '30s', target: 10 },
        { duration: '30s', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '2m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      thresholds: expectedThresholds,
    });
    expect(maxVus).toBe(100);
  });

  it('defaults to loopback and rejects non-local or non-HTTP targets', () => {
    const output = runNode(`
      import { resolveLocalBaseUrl } from ${JSON.stringify(profileModuleUrl)};
      const accepted = [
        resolveLocalBaseUrl(),
        resolveLocalBaseUrl('http://LOCALHOST:8080/api/'),
        resolveLocalBaseUrl('http://[::1]:80'),
      ];
      const rejected = ['https://localhost:3000', 'http://example.com', 'http://127.0.0.1:3000/path?x=1']
        .map((url) => { try { resolveLocalBaseUrl(url); return false; } catch { return true; } });
      console.log(JSON.stringify({ accepted, rejected }));
    `);
    const { accepted, rejected } = JSON.parse(output);

    expect(accepted).toEqual([
      'http://127.0.0.1:3000',
      'http://localhost:8080/api',
      'http://[::1]',
    ]);
    expect(rejected).toEqual([true, true, true]);
  });
});
