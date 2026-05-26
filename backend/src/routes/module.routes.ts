import express from 'express';
import { moduleConfigService } from '../services/ModuleConfigService';
import logger from '../utils/logger';

const router = express.Router();

/**
 * 获取自定义模块列表
 */
router.get('/modules', (req, res) => {
  try {
    const modules = moduleConfigService.getCustomModules();
    res.json({ modules });
  } catch (error) {
    logger.error('获取模块列表失败', error);
    res.status(500).json({ error: '获取模块列表失败' });
  }
});

/**
 * 更新自定义模块列表
 */
router.post('/modules', (req, res) => {
  try {
    const { modules } = req.body;
    
    if (!Array.isArray(modules)) {
      return res.status(400).json({ error: '模块列表必须是数组' });
    }

    // 验证模块名称
    for (const module of modules) {
      if (typeof module !== 'string' || !module.trim()) {
        return res.status(400).json({ error: '模块名称必须是非空字符串' });
      }
    }

    moduleConfigService.updateCustomModules(modules);
    res.json({ success: true, modules });
  } catch (error) {
    logger.error('更新模块列表失败', error);
    res.status(500).json({ error: '更新模块列表失败' });
  }
});

export default router;
