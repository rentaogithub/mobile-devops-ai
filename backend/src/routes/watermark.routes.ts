import { Router, Request, Response } from 'express';
import multer from 'multer';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import watermarkDecoderService from '../services/WatermarkDecoderService';
import logger from '../utils/logger';

const router = Router();
const uploadDir = process.env.UPLOAD_DIR || '../../nn-ios-platform-data/uploads';

fsSync.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    callback(null, name);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: parseInt(process.env.WATERMARK_MAX_FILE_SIZE || '20971520', 10),
  },
  fileFilter: (_req, file, callback) => {
    const isImageMime = file.mimetype.startsWith('image/');
    const isSupportedExt = /\.(jpe?g|png)$/i.test(file.originalname);
    if (isImageMime || isSupportedExt) {
      callback(null, true);
      return;
    }
    callback(new Error('仅支持 JPG/PNG 图片'));
  },
});

router.post('/decode', upload.single('file'), async (req: Request, res: Response) => {
  const filePath = req.file?.path;

  try {
    if (!req.file || !filePath) {
      return res.status(400).json({
        success: false,
        error: '未上传图片',
      });
    }

    const deep = req.body.deep !== 'false';
    const result = await watermarkDecoderService.decode(filePath, { deep, limit: 20 });

    logger.info('水印解析完成', {
      filename: req.file.originalname,
      success: result.success,
      uid: result.bestCandidate?.uid,
      candidates: result.candidates.length,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    logger.error('水印解析失败', {
      filename: req.file?.originalname,
      error: error.message,
    });

    return res.status(500).json({
      success: false,
      error: error.message || '水印解析失败',
    });
  } finally {
    if (filePath) {
      await fs.unlink(filePath).catch(() => undefined);
    }
  }
});

export default router;
