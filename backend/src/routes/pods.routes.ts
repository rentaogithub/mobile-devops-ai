import { Router, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import podService from '../services/PodService';
import logger from '../utils/logger';
import { adminMiddleware } from '../middleware/auth';

const router = Router();

const upload = multer({
  dest: process.env.UPLOAD_DIR || '../../dSYMTool-data/uploads',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '524288000'),
  },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.zip') || name.endsWith('.framework') || name.endsWith('.a') ||
        file.mimetype === 'application/zip' || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('仅支持 .zip、.framework、.a 格式文件'));
    }
  },
});

/**
 * POST /api/pods/publish
 * 上传并发布 Pod 组件（需要管理员权限）
 */
router.post('/publish', adminMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  let tempPath: string | undefined;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }

    const { name, version, lib_type, lib_name, summary, homepage, authors, license,
      platform_version, dependencies, sys_frameworks, sys_libraries } = req.body;

    if (!name || !version) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: '组件名称和版本号为必填项' });
    }

    tempPath = req.file.path;

    logger.info('收到 Pod 组件发布请求', { name, version, lib_type, filename: req.file.originalname });

    const component = await podService.publish(tempPath, req.file.originalname, {
      name, version, lib_type, lib_name, summary, homepage, authors, license,
      platform_version, dependencies, sys_frameworks, sys_libraries,
    });

    // 清理临时文件
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('Pod 组件发布失败', { error: error.message });

    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/list
 * 获取所有组件列表
 */
router.get('/list', async (_req: Request, res: Response) => {
  try {
    const components = await podService.getAll();
    res.json({ success: true, data: components });
  } catch (error: any) {
    logger.error('获取组件列表失败', { error: error.message });
    res.status(500).json({ success: false, error: '获取列表失败' });
  }
});

/**
 * GET /api/pods/names
 * 获取组件名称列表
 */
router.get('/names', async (_req: Request, res: Response) => {
  try {
    const names = await podService.getComponentNames();
    res.json({ success: true, data: names });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/:name/versions
 * 获取指定组件的所有版本
 */
router.get('/:name/versions', async (req: Request, res: Response) => {
  try {
    const versions = await podService.getVersions(req.params.name);
    res.json({ success: true, data: versions });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/:name/:version
 * 获取指定组件版本详情
 */
router.get('/:name/:version', async (req: Request, res: Response) => {
  try {
    const component = await podService.getOne(req.params.name, req.params.version);
    if (!component) {
      return res.status(404).json({ success: false, error: '组件不存在' });
    }
    res.json({ success: true, data: component });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/:name/:version/retry
 * 重试同步 spec 仓库（需要管理员权限）
 */
router.post('/:name/:version/retry', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const component = await podService.retrySync(req.params.name, req.params.version);
    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('重试同步失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/pods/:name/:version/podspec
 * 更新 podspec 内容并同步到远程仓库（需要管理员权限）
 */
router.put('/:name/:version/podspec', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { podspec_content } = req.body;
    if (!podspec_content) {
      return res.status(400).json({ success: false, error: 'podspec 内容不能为空' });
    }
    const component = await podService.updatePodspec(req.params.name, req.params.version, podspec_content);
    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('更新 podspec 失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/:name/:version/replace
 * 重新上传 zip 文件替换已有版本（需要管理员权限）
 */
router.post('/:name/:version/replace', adminMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  let tempPath: string | undefined;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }
    tempPath = req.file.path;

    const component = await podService.replaceZip(
      req.params.name, req.params.version, tempPath, req.file.originalname
    );

    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('替换 zip 失败', { error: error.message });
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/official/:name/versions
 * 查询官方 CocoaPods 组件的可用版本列表
 */
router.get('/official/:name/versions', async (req: Request, res: Response) => {
  try {
    const versions = await podService.fetchOfficialVersions(req.params.name);
    res.json({ success: true, data: versions });
  } catch (error: any) {
    logger.error('获取官方版本列表失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pods/official/:name/:version/dependencies
 * 查询官方组件的依赖列表，检查哪些已在内部仓库中
 */
router.get('/official/:name/:version/dependencies', async (req: Request, res: Response) => {
  try {
    const result = await podService.checkDependencies(req.params.name, req.params.version);
    res.json({ success: true, data: result });
  } catch (error: any) {
    logger.error('检查依赖失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pods/official/import
 * 从官方 CocoaPods 导入组件到内部仓库（需要管理员权限）
 */
router.post('/official/import', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { name, version, buildBinary, outputType, depVersionOverrides, selectedSubspecs, internalVersion, prepareCommand } = req.body;
    if (!name || !version) {
      return res.status(400).json({ success: false, error: '组件名称和版本号为必填项' });
    }

    // internalVersion: 用户自定义发布版本号（如 1.4.0.1），若不传则与 version 相同
    const publishVersion = (internalVersion || '').trim() || version;

    let component;
    if (buildBinary) {
      // 源码编译为二进制
      component = await podService.buildBinaryFromSource(name, version, outputType || 'framework', depVersionOverrides, selectedSubspecs, publishVersion, prepareCommand);
    } else {
      // 直接导入（二进制 SDK）
      component = await podService.importFromOfficial(name, version, publishVersion, prepareCommand);
    }

    res.json({ success: true, data: component });
  } catch (error: any) {
    logger.error('导入官方组件失败', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/pods/:name/:version
 * 删除指定组件版本（需要管理员权限）
 */
router.delete('/:name/:version', adminMiddleware, async (req: Request, res: Response) => {
  try {
    await podService.deleteVersion(req.params.name, req.params.version);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('删除组件版本失败', { error: error.message });
    res.status(error.message.includes('不存在') ? 404 : 500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/pods/:name
 * 删除整个组件（所有版本，需要管理员权限）
 */
router.delete('/:name', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const count = await podService.deleteComponent(req.params.name);
    res.json({ success: true, data: { deletedVersions: count } });
  } catch (error: any) {
    logger.error('删除组件失败', { error: error.message });
    res.status(error.message.includes('不存在') ? 404 : 500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
