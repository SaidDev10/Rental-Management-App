export const MAX_LOAD_VUS = 100;

const thresholds = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<400', 'p(99)<1000'],
  checks: ['rate>0.99'],
};

const urlPattern = /^(https?):\/\/(\[[^\]]+\]|[^/?#:]+)(?::([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i;

export function resolveLocalBaseUrl(value = 'http://127.0.0.1:3000') {
  const match = typeof value === 'string' ? urlPattern.exec(value) : null;
  if (!match) {
    throw new Error('BASE_URL must be a valid local HTTP URL.');
  }

  const [, protocol, rawHostname, rawPort, path, search, hash] = match;
  const hostname = rawHostname.toLowerCase();
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const port = rawPort ? Number(rawPort) : undefined;

  if (
    protocol.toLowerCase() !== 'http' ||
    !isLoopback ||
    (rawPort && (!/^\d+$/.test(rawPort) || port > 65535)) ||
    search ||
    hash
  ) {
    throw new Error('Load tests are restricted to an unauthenticated local loopback HTTP target.');
  }

  const portSuffix = port !== undefined && port !== 80 ? `:${port}` : '';
  return `http://${hostname}${portSuffix}${path}`.replace(/\/+$/, '');
}

export function resolveProfile(name = 'smoke') {
  if (name === 'smoke') {
    return {
      vus: 1,
      duration: '30s',
      thresholds,
    };
  }

  if (name === 'load') {
    return {
      stages: [
        { duration: '30s', target: 10 },
        { duration: '30s', target: 50 },
        { duration: '1m', target: MAX_LOAD_VUS },
        { duration: '2m', target: MAX_LOAD_VUS },
        { duration: '30s', target: 0 },
      ],
      thresholds,
    };
  }

  throw new Error(`Unknown PROFILE "${name}". Use "smoke" or "load".`);
}
