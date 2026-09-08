import { getDatabase } from '../database';
import { currentApplicationPlatform, currentProductLineId } from './ProductLineContext';
import { AsyncLocalStorage } from 'async_hooks';

export interface ComponentLibrary {
  id: string; name: string; platform: 'ios' | 'android'; configProductLineId: string;
}
const libraryContext = new AsyncLocalStorage<{ productLineId: string; library: ComponentLibrary }>();

// Keep legacy product_line_id as the library storage namespace. Binding never merges versions.
export class ComponentLibraryService {
  ensureIOS(productLineId: string) {
    getDatabase().prepare(`INSERT OR IGNORE INTO component_libraries (id, platform, config_product_line_id)
      VALUES (?, 'ios', ?)`).run(`ios:${productLineId}`, productLineId);
  }
  list(): ComponentLibrary[] {
    return getDatabase().prepare(`SELECT l.id, l.platform, l.config_product_line_id AS configProductLineId,
      p.name || ' · iOS 组件库' AS name FROM component_libraries l
      JOIN platform_product_lines p ON p.id = l.config_product_line_id WHERE p.active = 1 ORDER BY p.name, l.id`).all() as ComponentLibrary[];
  }
  validate(id: unknown, platform: string): ComponentLibrary {
    if (typeof id !== 'string') throw new Error('请选择有效的组件库');
    const library = this.list().find((item) => item.id === id);
    if (!library) throw new Error('组件库不存在或所属产品线已停用');
    if (library.platform !== platform) throw new Error('组件库只能由相同系统的应用共用');
    return library;
  }
  resolve(productLineId = currentProductLineId(), platform = currentApplicationPlatform()): ComponentLibrary {
    if (platform !== 'ios') throw new Error('当前组件库执行器仅支持 iOS；Android 组件适配待接入');
    const snapshot = libraryContext.getStore();
    if (snapshot?.productLineId === productLineId && snapshot.library.platform === platform) return snapshot.library;
    const app = getDatabase().prepare('SELECT component_library_id FROM platform_applications WHERE product_line_id = ? AND platform = ?').get(productLineId, platform) as { component_library_id?: string } | undefined;
    return this.validate(app?.component_library_id || `ios:${productLineId}`, platform);
  }
  status() {
    const library = this.resolve();
    const applications = getDatabase().prepare(`SELECT a.id, a.name, a.product_line_id AS productLineId
      FROM platform_applications a JOIN platform_product_lines p ON p.id = a.product_line_id
      WHERE a.platform = ? AND a.active = 1 AND p.active = 1
      AND COALESCE(a.component_library_id, 'ios:' || a.product_line_id) = ? ORDER BY a.name`).all(library.platform, library.id) as { id: string; name: string; productLineId: string }[];
    return { ...library, applications, shared: new Set(applications.map((app) => app.productLineId)).size > 1 };
  }
  assertVersionMutable() {
    if (this.status().shared) throw new Error('此组件库被多个产品线共用，已有版本不可覆盖或删除；请发布新版本');
  }
}
export const componentLibraryService = new ComponentLibraryService();
export function currentComponentCatalogProductLineId() { return componentLibraryService.resolve().configProductLineId; }
// A background publish started by this request must not change destination halfway through.
export function runWithComponentLibrary<T>(callback: () => T): T {
  return libraryContext.run({ productLineId: currentProductLineId(), library: componentLibraryService.resolve() }, callback);
}
