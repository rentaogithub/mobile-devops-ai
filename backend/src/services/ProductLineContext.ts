import { AsyncLocalStorage } from 'async_hooks';
import type { PlatformRole } from './AuthService';
import type { MobileApplication } from './ApplicationService';

export interface ProductLineContextValue {
  id: string;
  key: string;
  name: string;
  projectId: string;
  role: PlatformRole;
  application?: MobileApplication;
}

const productLineContext = new AsyncLocalStorage<ProductLineContextValue>();

export function runWithProductLine<T>(value: ProductLineContextValue, callback: () => T): T {
  return productLineContext.run(value, callback);
}

export function getProductLineContext(): ProductLineContextValue | undefined {
  return productLineContext.getStore();
}

export function currentProductLineId(): string {
  return getProductLineContext()?.id || 'nn';
}

export function currentProjectId(): string {
  return getProductLineContext()?.application?.projectId || getProductLineContext()?.projectId || 'nn-ios';
}

export function currentApplication() { return getProductLineContext()?.application; }
export function currentApplicationPlatform() { return currentApplication()?.platform || 'ios'; }
