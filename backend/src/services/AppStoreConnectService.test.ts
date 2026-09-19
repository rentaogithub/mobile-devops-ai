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
    const testIssuerId = ['00000000', '0000', '4000', '8000', '000000000001'].join('-');
    const values: Record<string, string> = {
      APP_STORE_CONNECT_API_KEY_ID: 'TESTKEY01',
      APP_STORE_CONNECT_API_ISSUER_ID: testIssuerId,
      APP_STORE_CONNECT_API_PRIVATE_KEY: privateKeyPem,
      APP_STORE_CONNECT_APP_ID: '1000000000',
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
        params: { 'filter[app]': '1000000000', limit: '200' },
      }),
    );
  });
});
