import * as ImageManipulator from 'expo-image-manipulator';

export const STOOL_CAPTURE_ROI_VERSION = 'stool-roi-768-square-v1';
export const STOOL_MODEL_PREPROCESSING_VERSION = 'stool-roi-768-to-imagenet-224-v1';
export const STOOL_CAPTURE_ROI_SIZE = 768;

const GUIDE_HORIZONTAL_INSET_RATIO = 0.12;
const GUIDE_TOP_RATIO = 0.25;
const GUIDE_MAX_HEIGHT_RATIO = 0.39;

export type ImageSize = {
  width: number;
  height: number;
};

export type ImageRect = ImageSize & {
  originX: number;
  originY: number;
};

function requirePositiveSize(size: ImageSize, label: string) {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error(`${label}_size_invalid`);
  }
}

/**
 * Retains the earlier guide's 12% side margins, 25% top position and 39% height band.
 * The visible ROI is square so the camera, reviewed training files and model input do not
 * introduce aspect-ratio distortion.
 */
export function calculateStoolGuideFrame(viewport: ImageSize): ImageRect {
  requirePositiveSize(viewport, 'camera_viewport');
  const maximumWidth = viewport.width * (1 - GUIDE_HORIZONTAL_INSET_RATIO * 2);
  const maximumHeight = viewport.height * GUIDE_MAX_HEIGHT_RATIO;
  const size = Math.max(1, Math.floor(Math.min(maximumWidth, maximumHeight)));
  return {
    originX: Math.round((viewport.width - size) / 2),
    originY: Math.round(viewport.height * GUIDE_TOP_RATIO),
    width: size,
    height: size,
  };
}

/** Maps the exact square shown over an aspect-fill camera preview back to source-photo pixels. */
export function mapGuideFrameToPhotoCrop(
  viewport: ImageSize,
  photo: ImageSize,
  guide = calculateStoolGuideFrame(viewport),
): ImageRect {
  requirePositiveSize(viewport, 'camera_viewport');
  requirePositiveSize(photo, 'photo');
  const previewScale = Math.max(viewport.width / photo.width, viewport.height / photo.height);
  const renderedWidth = photo.width * previewScale;
  const renderedHeight = photo.height * previewScale;
  const renderedOriginX = (viewport.width - renderedWidth) / 2;
  const renderedOriginY = (viewport.height - renderedHeight) / 2;

  const rawX = (guide.originX - renderedOriginX) / previewScale;
  const rawY = (guide.originY - renderedOriginY) / previewScale;
  const rawSize = Math.min(guide.width, guide.height) / previewScale;
  const size = Math.max(1, Math.min(Math.round(rawSize), photo.width, photo.height));
  const originX = Math.min(Math.max(0, Math.round(rawX)), photo.width - size);
  const originY = Math.min(Math.max(0, Math.round(rawY)), photo.height - size);

  return { originX, originY, width: size, height: size };
}

export function calculateCenteredSquareCrop(photo: ImageSize): ImageRect {
  requirePositiveSize(photo, 'photo');
  const size = Math.min(photo.width, photo.height);
  return {
    originX: Math.round((photo.width - size) / 2),
    originY: Math.round((photo.height - size) / 2),
    width: size,
    height: size,
  };
}

export async function prepareStoolRoiImage(uri: string, crop: ImageRect) {
  return ImageManipulator.manipulateAsync(
    uri,
    [
      { crop },
      { resize: { width: STOOL_CAPTURE_ROI_SIZE, height: STOOL_CAPTURE_ROI_SIZE } },
    ],
    { compress: 0.88, format: ImageManipulator.SaveFormat.JPEG },
  );
}
