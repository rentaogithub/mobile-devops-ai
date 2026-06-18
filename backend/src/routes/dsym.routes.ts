import { Router, Request, Response } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { FileHandlerService, StorageService } from '../services';
import { AppError, ErrorCode } from '../types';
import logger from '../utils/logger';
import { adminMiddleware } from '../middleware/auth';
import historyService from '../services/HistoryService';
import symbolicationCache from '../services/SymbolicationCacheService';

const router = Router();

// 配置 Multer
const upload = multer({
  dest: process.env.UPLOAD_DIR || '../../nn-ios-platform-data/uploads',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '524288000'), // 500MB
  },
});

const fileHandler = new FileHandlerService();
const storage = new StorageService();

/**
 * POST /api/dsym/upload
 * 上传 dSYM 文件（需要管理员权限）
 */
router.post('/upload', adminMiddleware, upload.single('file'), async (req: Request, res: Response) => {
  let tempPath: string | undefined;
  let dsymPath: string | undefined;
  let permanentPath: string | undefined;

  try {
    if (!req.file) {
      throw new AppError(ErrorCode.INVALID_FILE_FORMAT, '未上传文件', 400);
    }

    logger.info('收到 dSYM 上传请求', {
      filename: req.file.originalname,
      size: req.file.size,
      path: req.file.path,
    });

    // 处理上传的文件
    logger.info('开始处理上传文件');
    tempPath = await fileHandler.processUploadedFile(req.file);
    logger.info('文件处理完成', { tempPath });

    // 识别并提取 dSYM
    logger.info('开始识别和提取 dSYM');
    dsymPath = await fileHandler.identifyAndExtractDSYM(tempPath);
    logger.info('dSYM 提取完成', { dsymPath });

    // 提取 UUID
    logger.info('开始提取 UUID');
    const uuid = await fileHandler.extractUUID(dsymPath);
    logger.info('UUID 提取完成', { uuid });

    // 提取应用信息
    const appInfo = await fileHandler.extractAppInfo(dsymPath);

    // 同应用同版本覆盖：先删除旧记录和旧 dSYM 文件
    const sameVersionDsyms = await storage.findByAppNameAndVersion(appInfo.appName, appInfo.version);
    for (const existing of sameVersionDsyms) {
      logger.info('覆盖同版本 dSYM，删除旧记录', {
        appName: existing.appName,
        version: existing.version,
        uuid: existing.uuid,
        filePath: existing.filePath,
      });
      await storage.deleteDSYM(existing.uuid);
    }

    // 覆盖同版本后，若 UUID 仍存在，说明同一个 UUID 被其他版本占用，拒绝上传
    const uuidOwner = await storage.findByUUID(uuid);
    if (uuidOwner) {
      await fileHandler.cleanupUploadArtifacts(tempPath, dsymPath);
      throw new AppError(
        ErrorCode.INVALID_FILE_FORMAT,
        `UUID ${uuid} 已存在于 ${uuidOwner.appName}@${uuidOwner.version}`,
        409
      );
    }

    // 移动到永久存储
    permanentPath = await fileHandler.moveToPermanentStorage(dsymPath, uuid);

    // 获取文件大小
    const fileSize = fileHandler.getFileSize(permanentPath);

    // 保存到数据库
    const dsymInfo = await storage.saveDSYMInfo({
      uuid,
      appName: appInfo.appName,
      version: appInfo.version,
      buildNumber: appInfo.buildNumber,
      architecture: appInfo.architecture,
      filePath: permanentPath,
      fileSize,
    });

    logger.info('dSYM 上传成功', { uuid, appName: appInfo.appName });

    // 上传成功后只保留永久存储中的 .dSYM，清理压缩包和解压外层目录
    await fileHandler.cleanupUploadArtifacts(tempPath, dsymPath, permanentPath);

    // 清除符号化缓存，确保使用新的 dSYM 重新符号化
    symbolicationCache.clear();
    logger.info('已清除符号化缓存（dSYM 更新）');

    res.json({
      success: true,
      data: {
        uuid: dsymInfo.uuid,
        appName: dsymInfo.appName,
        version: dsymInfo.version,
        uploadTime: dsymInfo.uploadTime,
      },
    });
  } catch (error: any) {
    logger.error('dSYM 上传失败', { 
      error: error.message,
      stack: error.stack,
      filename: req.file?.originalname,
    });

    // 清理临时文件
    await fileHandler.cleanupUploadArtifacts(tempPath, dsymPath, permanentPath);

    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: error.message,
        errorCode: error.code,
      });
    } else {
      // 提供更详细的错误信息
      let errorMessage = '上传失败';
      if (error.message) {
        errorMessage = `上传失败: ${error.message}`;
      }
      
      res.status(500).json({
        success: false,
        error: errorMessage,
      });
    }
  }
});

/**
 * GET /api/dsym/list
 * 获取所有 dSYM 列表
 */
router.get('/list', async (req: Request, res: Response) => {
  try {
    const dsyms = await storage.getAllDSYMs();

    res.json({
      success: true,
      data: dsyms,
    });
  } catch (error: any) {
    logger.error('获取 dSYM 列表失败', { error: error.message });

    res.status(500).json({
      success: false,
      error: '获取列表失败',
    });
  }
});

/**
 * PUT /api/dsym/:uuid
 * 更新 dSYM 信息（需要管理员权限）
 */
router.put('/:uuid', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;
    const { version, notes, relatedAppVersions } = req.body;

    logger.info('更新 dSYM 信息', { uuid, version, notes, relatedAppVersions });

    // 检查 dSYM 是否存在
    const existing = await storage.findByUUID(uuid);
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'dSYM 不存在',
      });
    }

    // 更新信息
    const updated = await storage.updateDSYMInfo(uuid, { version, notes, relatedAppVersions });

    logger.info('dSYM 信息更新成功', { uuid });

    res.json({
      success: true,
      data: updated,
    });
  } catch (error: any) {
    logger.error('更新 dSYM 信息失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '更新失败',
    });
  }
});

/**
 * GET /api/dsym/:uuid/download
 * 下载 dSYM 文件
 */
router.get('/:uuid/download', async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;

    logger.info('下载 dSYM', { uuid });

    // 查找 dSYM 信息
    const dsymInfo = await storage.findByUUID(uuid);
    if (!dsymInfo) {
      return res.status(404).json({
        success: false,
        error: 'dSYM 不存在',
      });
    }

    // 检查文件是否存在
    if (!fs.existsSync(dsymInfo.filePath)) {
      logger.error('dSYM 文件不存在', { uuid, filePath: dsymInfo.filePath });
      return res.status(404).json({
        success: false,
        error: 'dSYM 文件不存在',
      });
    }

    // 压缩 dSYM 目录为 zip 文件
    const fileName = `${dsymInfo.appName}_${dsymInfo.version}_${uuid.substring(0, 8)}.dSYM.zip`;
    
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);

    const archive = archiver('zip', {
      zlib: { level: 9 } // 最高压缩级别
    });

    archive.on('error', (err: any) => {
      logger.error('压缩 dSYM 失败', { error: err.message, uuid });
      res.status(500).json({
        success: false,
        error: '压缩文件失败',
      });
    });

    archive.pipe(res);

    // 添加 dSYM 目录到压缩包
    const dsymName = path.basename(dsymInfo.filePath);
    archive.directory(dsymInfo.filePath, dsymName);

    await archive.finalize();

    logger.info('dSYM 下载成功', { uuid, fileName });
  } catch (error: any) {
    logger.error('下载 dSYM 失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: '下载失败',
    });
  }
});

/**
 * DELETE /api/dsym/:uuid
 * 删除 dSYM 文件（需要管理员权限）
 */
router.delete('/:uuid', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;

    logger.info('删除 dSYM', { uuid });

    await storage.deleteDSYM(uuid);

    logger.info('dSYM 删除成功', { uuid });
    symbolicationCache.clear();
    logger.info('已清除符号化缓存（dSYM 删除）', { uuid });

    res.json({
      success: true,
    });
  } catch (error: any) {
    logger.error('删除 dSYM 失败', { error: error.message });

    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: 'dSYM 不存在',
      });
    } else {
      res.status(500).json({
        success: false,
        error: '删除失败',
      });
    }
  }
});

export default router;
