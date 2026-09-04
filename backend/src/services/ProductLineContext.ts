import { AsyncLocalStorage } from 'async_hooks';
import type { PlatformRole } from './AuthService';

export interface ProductLineContextValue {
  id: string;
  key: string;
  name: string;
  projectId: string;
  role: PlatformRole;
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
  return getProductLineContext()?.projectId || 'nn-ios';
}
