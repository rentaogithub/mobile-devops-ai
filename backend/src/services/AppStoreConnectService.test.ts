import axios from 'axios';
import { generateKeyPairSync } from 'crypto';
import { appStoreConnectService } from './AppStoreConnectService';
import { productLineConfigService } from './ProductLineConfigService';

describe('AppStoreConnectService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads and classifies TestFlight groups for one product line', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const values: Record<string, string> = {
      APP_STORE_CONNECT_API_KEY_ID: 'K75M4WYA7F',
      APP_STORE_CONNECT_API_ISSUER_ID: '07a7751b-6b24-4381-866e-b42e22910b1a',
      APP_STORE_CONNECT_API_PRIVATE_KEY: privateKeyPem,
      APP_STORE_CONNECT_APP_ID: '1627452460',
    };
    jest.spyOn(productLineConfigService, 'get').mockImplementation((key) => values[key] || '');
    const request = jest.spyOn(axios, 'get').mockResolvedValue({
      data: {
        data: [
          { id: 'external-id', attributes: { name: '外部测试', isInternalGroup: false } },
          { id: 'internal-id', attributes: { name: '测试', isInternalGroup: true } },
        ],
      },
    });

    await expect(appStoreConnectService.listTestFlightGroups('nn')).resolves.toEqual([
      { id: 'internal-id', name: '测试', isInternal: true },
      { id: 'external-id', name: '外部测试', isInternal: false },
    ]);
    expect(request).toHaveBeenCalledWith(
      'https://api.appstoreconnect.apple.com/v1/betaGroups',
      expect.objectContaining({
        headers: { Authorization: expect.stringMatching(/^Bearer /) },
        params: { 'filter[app]': '1627452460', limit: '200' },
      }),
    );
  });
});
