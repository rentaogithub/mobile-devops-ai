import { describe, expect, test } from 'vitest';
import { containedImageViewport, normalizedPointInContainedImage } from './containedImageCoordinates';

describe('contained image coordinates', () => {
  test('竖屏截图在宽盒子中横向留白时只按真实图片区域换算', () => {
    const viewport = containedImageViewport(650, 540, 1206, 2622);
    const cancelOnImage = { x: 358 / 402, y: 775 / 874 };
    const clickInBox = {
      x: viewport.left + (cancelOnImage.x * viewport.width),
      y: viewport.top + (cancelOnImage.y * viewport.height),
    };
    const normalized = normalizedPointInContainedImage(clickInBox, viewport);
    expect(normalized.x).toBeCloseTo(cancelOnImage.x, 6);
    expect(normalized.y).toBeCloseTo(cancelOnImage.y, 6);
    // 旧算法会得到约 65%，对应 WDA x=261 的扬声器单元格。
    expect(clickInBox.x / 650).toBeCloseTo(0.65, 2);
  });

  test('点击留白区域时将坐标夹到图片边界', () => {
    const viewport = containedImageViewport(650, 540, 1206, 2622);
    expect(normalizedPointInContainedImage({ x: 0, y: 270 }, viewport).x).toBe(0);
    expect(normalizedPointInContainedImage({ x: 650, y: 270 }, viewport).x).toBe(1);
  });
});
