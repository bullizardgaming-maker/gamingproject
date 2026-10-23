import { describe, expect, it } from 'vitest';
import { client, makeUser, setup } from './helpers.js';

describe('merchant API switch', () => {
  it('is hidden at launch: keys, docs and the developer routes answer 404/403 until MERCHANT_API_ENABLED', async () => {
    const off = await setup({ MERCHANT_API_ENABLED: 'false' });
    try {
      const seller = await makeUser(off, { tier: 2 });
      expect((await seller.api.get('/v1/developer/api-keys')).status).toBe(404);
      expect((await seller.api.post('/v1/developer/api-keys', { name: 'bot', scopes: ['orders:read'] })).status).toBe(404);
      expect((await client(off.app).get('/v1/openapi.json')).status).toBe(404);
      expect((await client(off.app, 'mk_abcdefgh_' + 'x'.repeat(24)).get('/v1/merchant/orders')).body.error.code).toBe('merchant_api_disabled');
      expect((await client(off.app).get('/v1/features')).body).toMatchObject({ merchantApi: false });
    } finally {
      await off.close();
    }
  });
});

