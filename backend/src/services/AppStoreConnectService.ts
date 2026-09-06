import axios from 'axios';
import { sign } from 'crypto';
import { productLineConfigService } from './ProductLineConfigService';

const APP_STORE_CONNECT_API_BASE = 'https://api.appstoreconnect.apple.com/v1';

export interface AppStoreConnectTestFlightGroup {
  id: string;
  name: string;
  isInternal: boolean;
}

function base64Url(input: Buffer | string) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

class AppStoreConnectService {
  private createJwt(productLineId: string) {
    const keyId = productLineConfigService.get('APP_STORE_CONNECT_API_KEY_ID', productLineId).trim();
    const issuerId = productLineConfigService.get('APP_STORE_CONNECT_API_ISSUER_ID', productLineId).trim();
    const privateKey = productLineConfigService.get('APP_STORE_CONNECT_API_PRIVATE_KEY', productLineId)
      .trim()
      .replace(/\\n/g, '\n');
    const missing = [
      !keyId ? 'Apple 原始 .p8 私钥（用于识别 Key ID）' : '',
      !issuerId ? 'Issuer ID' : '',
      !privateKey ? 'App Store Connect 私钥' : '',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`请先保存当前产品线的 ${missing.join('、')}`);
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
    const payload = {
      iss: issuerId,
      iat: issuedAt,
      exp: issuedAt + 20 * 60,
      aud: 'appstoreconnect-v1',
    };
    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
    const signature = sign('sha256', Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${signingInput}.${base64Url(signature)}`;
  }

  async listTestFlightGroups(productLineId: string): Promise<AppStoreConnectTestFlightGroup[]> {
    const appId = productLineConfigService.get('APP_STORE_CONNECT_APP_ID', productLineId).trim();
    if (!appId) throw new Error('请先保存当前产品线的 App ID');

    try {
      const response = await axios.get(`${APP_STORE_CONNECT_API_BASE}/betaGroups`, {
        timeout: 30000,
        headers: { Authorization: `Bearer ${this.createJwt(productLineId)}` },
        params: {
          'filter[app]': appId,
          limit: '200',
        },
      });
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      return rows
        .map((group: any) => ({
          id: String(group?.id || '').trim(),
          name: String(group?.attributes?.name || '').trim(),
          isInternal: Boolean(group?.attributes?.isInternalGroup),
        }))
        .filter((group: AppStoreConnectTestFlightGroup) => group.id && group.name)
        .sort((left: AppStoreConnectTestFlightGroup, right: AppStoreConnectTestFlightGroup) => {
          if (left.isInternal !== right.isInternal) return left.isInternal ? -1 : 1;
          return left.name.localeCompare(right.name, 'zh-CN');
        });
    } catch (error: any) {
      const appleError = error?.response?.data?.errors?.[0];
      const detail = String(appleError?.detail || appleError?.title || appleError?.code || '').trim();
      if (detail) throw new Error(`Apple API 获取 TestFlight 测试组失败：${detail}`);
      throw new Error(error?.message || 'Apple API 获取 TestFlight 测试组失败');
    }
  }
}

export const appStoreConnectService = new AppStoreConnectService();
