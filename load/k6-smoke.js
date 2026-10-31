import http from 'k6/http';
import { check, sleep } from 'k6';

import { resolveLocalBaseUrl, resolveProfile } from './k6-profile.js';

const baseUrl = resolveLocalBaseUrl(__ENV.BASE_URL);

export const options = resolveProfile(__ENV.PROFILE ?? 'smoke');

export default function () {
  const response = http.get(`${baseUrl}/health`, { tags: { endpoint: 'health' } });

  check(response, {
    'health returns HTTP 200': (result) => result.status === 200,
    'health identifies the rental API': (result) =>
      result.status === 200 && result.json('ok') === true && result.json('service') === 'rental-api',
  });

  sleep(1);
}
