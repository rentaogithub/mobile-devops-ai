import { componentLibraryService } from './ComponentLibraryService';
import { randomUUID } from 'crypto';
import { getDatabase } from '../database';
import { applicationServiceCatalog, defaultApplicationServices, ApplicationServiceId, ServiceApplication } from './ApplicationServiceCatalog';

export type MobilePlatform = 'ios' | 'android';
export interface AndroidApplicationConfig {
  repositoryUrl: string;
  buildJob: string;
  qualityJob: string;
  buildVariant: string;
  apkPath: string;
  deviceSerial: string;
}
export interface MobileApplication {
  id: string;
  productLineId: string;
  platform: MobilePlatform;
  name: string;
  packageId: string;
  projectId: string;
  active: boolean;
  config: AndroidApplicationConfig;
  services?: ApplicationServiceId[];
  componentLibraryId?: string;
  serviceOptions?: ServiceApplication['serviceOptions'];
}
const emptyConfig: AndroidApplicationConfig = { repositoryUrl: '', buildJob: '', qualityJob: '', buildVariant: 'debug', apkPath: '', deviceSerial: '' };

function mapApplication(row: any): MobileApplication {
  return { componentLibraryId: row.component_library_id || (row.platform === 'ios' ? `ios:${row.product_line_id}` : undefined), id: row.id, productLineId: row.product_line_id, platform: row.platform, name: row.name, packageId: row.package_id, projectId: row.workflow_project_id, active: Boolean(row.active), services: row.services_json === null || row.services_json === undefined ? defaultApplicationServices(row.platform, row.product_line_id) : JSON.parse(row.services_json), serviceOptions: JSON.parse(row.service_options_json || '{}'), config: { ...emptyConfig, ...JSON.parse(row.config_json) } };
}

function validatedConfig(value: unknown, previous = emptyConfig): AndroidApplicationConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应用配置必须是对象');
  const result = { ...previous };
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(emptyConfig, key) || typeof raw !== 'string' || raw.length > 1000) throw new Error(`无效配置字段：${key}`);
    const text = raw.trim();
    if (text && key === 'repositoryUrl') {
      let url: URL;
      try { url = new URL(text); } catch { throw new Error('仓库地址须为 HTTPS 或 SSH URL'); }
      if (!url.hostname || !['https:', 'ssh:'].includes(url.protocol) || url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash) throw new Error('仓库地址不能携带凭据或查询参数');
    }
    if (text && ['buildJob', 'qualityJob'].includes(key) && !/^[\w.-]+(?:\/[\w.-]+)*$/.test(text)) throw new Error('Jenkins Job 路径无效');
    if (text && key === 'buildVariant' && !/^[a-zA-Z][a-zA-Z0-9]{0,79}$/.test(text)) throw new Error('构建变体无效');
    if (text && key === 'deviceSerial' && !/^[a-zA-Z0-9_.:-]{1,160}$/.test(text)) throw new Error('设备序列号无效');
    if (text && key === 'apkPath' && (!/^[a-zA-Z0-9_.\/-]+\.apk$/.test(text) || text.startsWith('/') || text.split('/').includes('..'))) throw new Error('APK 路径须为仓库内的相对路径');
    (result as any)[key] = text;
  }
  return result;
}

function validateServices(platform: MobilePlatform, value: unknown): ApplicationServiceId[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new Error('选配服务必须为服务标识数组');
  const result = [...new Set(value)] as ApplicationServiceId[];
  for (const id of result) {
    const service = applicationServiceCatalog.find((item) => item.id === id);
    if (!service || !service.platforms.includes(platform)) throw new Error(`${id} 不支持 ${platform} 应用`);
    if (service.requires.some((dependency) => !result.includes(dependency))) throw new Error(`${service.name} 需要同时启用：${service.requires.join('、')}`);
  }
  if (result.includes('sentry') && result.includes('bugly')) throw new Error('每个应用请选择一个主崩溃服务提供商');
  return result;
}
function validateOptions(value: unknown): ServiceApplication['serviceOptions'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务参数必须为对象');
  const result: NonNullable<ServiceApplication['serviceOptions']> = {};
  for (const [id, settings] of Object.entries(value)) {
    if (!['sentry', 'bugly'].includes(id) || !settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('服务参数无效');
    const parsed: { appId?: string; consoleUrl?: string } = {};
    for (const [key, raw] of Object.entries(settings)) {
      if (!['appId', 'consoleUrl'].includes(key) || typeof raw !== 'string' || raw.length > 1000) throw new Error('只允许应用标识和无凭据的控制台 URL；密钥请在凭据管理中配置');
      const text = raw.trim();
      if (key === 'appId' && text && !/^[a-zA-Z0-9_.:-]{1,160}$/.test(text)) throw new Error('服务应用标识无效');
      if (key === 'consoleUrl' && text) {
        let url: URL; try { url = new URL(text); } catch { throw new Error('控制台地址无效'); }
        const parameterKeys = [...url.searchParams.keys(), ...new URLSearchParams(url.hash.split('?')[1] || '').keys()];
        if (parameterKeys.some((key) => /token|secret|password|api[_-]?key|authorization/i.test(key))) throw new Error('控制台地址不能携带密钥或登录凭据');
        if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || /(?:token|secret|password|api[_-]?key|authorization)=/i.test(text)) throw new Error('控制台地址不能携带密钥或登录凭据');
      }
      parsed[key as 'appId' | 'consoleUrl'] = text;
    }
    result[id as 'sentry' | 'bugly'] = parsed;
  }
  return result;
}

export class ApplicationService {
  list(productLineId: string, includeInactive = false) {
    return (getDatabase().prepare(`SELECT * FROM platform_applications WHERE product_line_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY platform DESC, created_at`).all(productLineId) as any[]).map(mapApplication);
  }
  get(id: string, productLineId: string) {
    const row = getDatabase().prepare('SELECT * FROM platform_applications WHERE id = ? AND product_line_id = ?').get(id, productLineId);
    return row ? mapApplication(row) : null;
  }
  ensureIOS(productLineId: string) {
    componentLibraryService.ensureIOS(productLineId);
    const timestamp = new Date().toISOString();
    getDatabase().prepare(`INSERT OR IGNORE INTO platform_applications
      (id, product_line_id, platform, name, package_id, workflow_project_id, services_json, created_at, updated_at)
      SELECT id || ':ios', id, 'ios', name || ' iOS', COALESCE(bundle_id, ''), project_id, '[]', ?, ? FROM platform_product_lines WHERE id = ?
    `).run(timestamp, timestamp, productLineId);
  }
  create(productLineId: string, input: Record<string, any>) {
    const product = getDatabase().prepare('SELECT * FROM platform_product_lines WHERE id = ? AND active = 1').get(productLineId) as any;
    if (!product) throw new Error('产品线不存在或已停用');
    if (!['ios', 'android'].includes(input.platform)) throw new Error('应用平台仅支持 ios 或 android');
    const name = String(input.name || '').trim();
    const packageId = String(input.packageId || '').trim();
    if (!name || name.length > 80) throw new Error('应用名称须为 1-80 字符');
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageId)) throw new Error('应用标识须为有效的 Bundle ID 或 applicationId');
    if (this.list(productLineId, true).some((app) => app.platform === input.platform)) throw new Error('此产品线已存在该平台应用，请编辑已有应用');
    const config = validatedConfig(input.config || {});
    const services = validateServices(input.platform, input.services === undefined ? defaultApplicationServices(input.platform, productLineId) : input.services);
    const serviceOptions = validateOptions(input.serviceOptions || {});
    if (input.platform === 'ios') componentLibraryService.ensureIOS(productLineId);
    const componentLibraryId = input.componentLibraryId === undefined ? null : componentLibraryService.validate(input.componentLibraryId, input.platform).id;
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const projectId = input.platform === 'ios' ? product.project_id : `${product.project_id}:android`;
    if (projectId.length > 120) throw new Error('产品线 Workflow 标识过长，无法创建 Android 命名空间');
    if (input.platform === 'android' && getDatabase().prepare('SELECT 1 FROM platform_product_lines WHERE project_id = ?').get(projectId)) throw new Error('Android Workflow 标识与现有产品线冲突');
    getDatabase().prepare(`INSERT INTO platform_applications
      (id, product_line_id, platform, name, package_id, workflow_project_id, config_json, services_json, service_options_json, component_library_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, productLineId, input.platform, name, packageId, projectId, JSON.stringify(config), JSON.stringify(services), JSON.stringify(serviceOptions), componentLibraryId, timestamp, timestamp);
    return this.get(id, productLineId)!;
  }
  update(productLineId: string, id: string, input: Record<string, any>) {
    const app = this.get(id, productLineId);
    if (!app) throw new Error('应用不存在');
    if (Object.keys(input).some((key) => !['name', 'config', 'services', 'serviceOptions', 'componentLibraryId'].includes(key))) throw new Error('仅可修改名称与执行配置；平台、应用标识和 Workflow 标识不可变');
    const componentLibraryId = input.componentLibraryId === undefined ? app.componentLibraryId : componentLibraryService.validate(input.componentLibraryId, app.platform).id;
    const name = input.name === undefined ? app.name : String(input.name).trim();
    if (!name || name.length > 80) throw new Error('应用名称须为 1-80 字符');
    const config = input.config === undefined ? app.config : validatedConfig(input.config, app.config);
    const services = validateServices(app.platform, input.services === undefined ? app.services : input.services);
    const serviceOptions = input.serviceOptions === undefined ? app.serviceOptions : { ...app.serviceOptions, ...validateOptions(input.serviceOptions) };
    getDatabase().prepare('UPDATE platform_applications SET name = ?, config_json = ?, services_json = ?, service_options_json = ?, component_library_id = ?, updated_at = ? WHERE id = ? AND product_line_id = ?').run(name, JSON.stringify(config), JSON.stringify(services), JSON.stringify(serviceOptions), componentLibraryId || null, new Date().toISOString(), id, productLineId);
    return this.get(id, productLineId)!;
  }
}
export const applicationService = new ApplicationService();
