import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

/**
 * 模块配置服务
 * 管理自定义模块列表
 */
export class ModuleConfigService {
  private configPath: string;
  private defaultModules = ['NNIM', 'NNRtc', 'leigod_im_cross_sdk'];

  constructor() {
    // 使用与数据库相同的数据目录
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), '..', 'dSYMTool-data');
    this.configPath = path.join(dataDir, 'module-config.json');
    this.ensureConfigFile();
  }

  /**
   * 确保配置文件存在
   */
  private ensureConfigFile(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        // 确保目录存在
        const dir = path.dirname(this.configPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        const defaultConfig = {
          customModules: this.defaultModules,
          updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
        logger.info('创建默认模块配置文件');
      }
    } catch (error) {
      logger.error('创建模块配置文件失败', error);
    }
  }

  /**
   * 获取自定义模块列表
   */
  getCustomModules(): string[] {
    try {
      const data = fs.readFileSync(this.configPath, 'utf-8');
      const config = JSON.parse(data);
      return config.customModules || this.defaultModules;
    } catch (error) {
      logger.error('读取模块配置失败', error);
      return this.defaultModules;
    }
  }

  /**
   * 更新自定义模块列表
   */
  updateCustomModules(modules: string[]): void {
    try {
      const config = {
        customModules: modules,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      logger.info('更新模块配置成功', { modules });
    } catch (error) {
      logger.error('更新模块配置失败', error);
      throw error;
    }
  }
}

export const moduleConfigService = new ModuleConfigService();
