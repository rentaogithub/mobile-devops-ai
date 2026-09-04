export interface ContainedImageViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function containedImageViewport(
  boxWidth: number,
  boxHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): ContainedImageViewport {
  if (boxWidth <= 0 || boxHeight <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return { left: 0, top: 0, width: Math.max(boxWidth, 1), height: Math.max(boxHeight, 1) };
  }
  const imageRatio = naturalWidth / naturalHeight;
  const boxRatio = boxWidth / boxHeight;
  if (boxRatio > imageRatio) {
    const width = boxHeight * imageRatio;
    return { left: (boxWidth - width) / 2, top: 0, width, height: boxHeight };
  }
  const height = boxWidth / imageRatio;
  return { left: 0, top: (boxHeight - height) / 2, width: boxWidth, height };
}

export function normalizedPointInContainedImage(
  point: { x: number; y: number },
  viewport: ContainedImageViewport,
) {
  return {
    x: Math.min(Math.max((point.x - viewport.left) / Math.max(viewport.width, 1), 0), 1),
    y: Math.min(Math.max((point.y - viewport.top) / Math.max(viewport.height, 1), 0), 1),
  };
}
