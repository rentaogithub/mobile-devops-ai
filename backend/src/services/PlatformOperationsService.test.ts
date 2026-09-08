jest.mock('../database', () => ({}));
jest.mock('./AuthService', () => ({ authService: {} }));
jest.mock('./PlatformConfigService', () => ({
  platformConfigService: { status: () => ({ aiApiKeyConfigured: true }) },
}));
jest.mock('./ApplicationCapabilityService', () => ({ hasCurrentApplicationServices: jest.fn(() => true) }));

import { PlatformOperationsService } from './PlatformOperationsService';
import { hasCurrentApplicationServices } from './ApplicationCapabilityService';

describe('local-device dependency health', () => {
  let operations: PlatformOperationsService;
  let fetchJson: jest.SpyInstance;
  beforeEach(() => {
    operations = new PlatformOperationsService();
    jest.mocked(hasCurrentApplicationServices).mockReturnValue(true);
    fetchJson = jest.spyOn(operations as any, 'fetchJson').mockImplementation(async (endpoint: unknown) => {
      if (endpoint === '/api/jenkins/nn/quality/device-pools/status') {
        return { data: { pools: [{ stats: { total: 1, online: 1, idle: 1 } }] } };
      }
      return { data: { builds: [], issues: [] } };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('is healthy with local devices and only queries current integration endpoints', async () => {
    const result = await operations.dependencies();
    expect(result.status).toBe('healthy');
    expect(Object.keys(result.dependencies).sort()).toEqual(['devices', 'jenkins', 'openai', 'sentry', 'xcuiTestRunner']);
    expect(fetchJson.mock.calls.map(([endpoint]) => endpoint).sort()).toEqual([
      '/api/jenkins/nn/builds', '/api/jenkins/nn/quality/device-pools/status', '/api/sentry-analysis/issues',
    ]);
    expect(result.dependencies.devices).toMatchObject({ status: 'up', detail: { online: 1 } });
  });

  it('reports degraded health when the local device detector has no online devices', async () => {
    fetchJson.mockResolvedValue({ data: { pools: [] } });
    const result = await operations.dependencies();
    expect(result.status).toBe('degraded');
    expect(result.dependencies.devices.status).toBe('degraded');
  });

  it('does not probe devices when quality is disabled for the current application', async () => {
    jest.mocked(hasCurrentApplicationServices).mockImplementation((service) => service !== 'quality');
    const result = await operations.dependencies();
    expect(result.dependencies.devices.status).toBe('disabled');
    expect(fetchJson.mock.calls.some(([endpoint]) => String(endpoint).includes('device-pools'))).toBe(false);
  });
});
