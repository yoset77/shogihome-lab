/**
 * Compress an image blob for vision scanning.
 * Resizes the image so the shorter side is at most 960px,
 * then outputs a JPEG at 80% quality.
 *
 * EXIF Orientation metadata is applied before compression so the output
 * JPEG has the correct pixel orientation. We use createImageBitmap with
 * { imageOrientation: "from-image" } when available, and fall back to a
 * plain Image element for older browsers.
 *
 * JPEG/PNG images that are already small enough (short side <= 960px) are
 * returned without re-encoding.
 */

const TARGET_SHORT_SIDE = 960;
const JPEG_QUALITY = 0.8;
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png"]);

function logTiming(label: string, startTime: number): void {
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
    const elapsed = Math.round(performance.now() - startTime);

    console.log(`[compressImageForVision] ${label}: ${elapsed}ms`);
  }
}

function isSupportedImageType(type: string): boolean {
  return SUPPORTED_TYPES.has(type);
}

export function compressImageForVision(blob: Blob): Promise<Blob> {
  const startTime = performance.now();

  return new Promise((resolve, reject) => {
    if (!isSupportedImageType(blob.type)) {
      reject(new Error(`Unsupported image type: ${blob.type}`));
      return;
    }

    if (typeof createImageBitmap !== "function") {
      loadImageFallback(blob, resolve, reject);
      return;
    }

    createImageBitmap(blob, { imageOrientation: "from-image" })
      .then((bitmap) => {
        const width = bitmap.width;
        const height = bitmap.height;
        const shortSide = Math.min(width, height);

        // Fast path: already small enough, return the original blob.
        if (shortSide <= TARGET_SHORT_SIDE) {
          bitmap.close();
          logTiming("fast path (skip compress)", startTime);
          resolve(blob);
          return;
        }

        const scale = TARGET_SHORT_SIDE / shortSide;
        const newWidth = Math.round(width * scale);
        const newHeight = Math.round(height * scale);

        // Resize during decode to avoid keeping a full-resolution bitmap.
        createImageBitmap(bitmap, {
          resizeWidth: newWidth,
          resizeHeight: newHeight,
          resizeQuality: "medium",
        })
          .then((resizedBitmap) => {
            bitmap.close();
            encodeJpegFromBitmap(resizedBitmap, JPEG_QUALITY)
              .then((result) => {
                resizedBitmap.close();
                logTiming("resize during decode", startTime);
                resolve(result);
              })
              .catch(reject);
          })
          .catch(() => {
            // Fallback: scale the full-resolution bitmap using canvas.
            encodeJpegFromBitmapWithSize(bitmap, newWidth, newHeight)
              .then((result) => {
                bitmap.close();
                logTiming("canvas fallback", startTime);
                resolve(result);
              })
              .catch(reject);
          });
      })
      .catch(() => {
        loadImageFallback(blob, resolve, reject);
      });
  });
}

function encodeJpegFromBitmap(bitmap: ImageBitmap, quality: number): Promise<Blob> {
  return encodeJpegFromBitmapWithSize(bitmap, bitmap.width, bitmap.height, quality);
}

function encodeJpegFromBitmapWithSize(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number = JPEG_QUALITY,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Failed to get 2d context"));
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(bitmap, 0, 0, width, height);

    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error("Canvas toBlob returned null"));
        }
      },
      "image/jpeg",
      quality,
    );
  });
}

function loadImageFallback(
  blob: Blob,
  resolve: (blob: Blob) => void,
  reject: (error: Error) => void,
): void {
  const img = new Image();
  const url = URL.createObjectURL(blob);

  img.onload = () => {
    URL.revokeObjectURL(url);

    const targetShortSide = TARGET_SHORT_SIDE;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const shortSide = Math.min(width, height);

    let newWidth = width;
    let newHeight = height;
    if (shortSide > targetShortSide) {
      const scale = targetShortSide / shortSide;
      newWidth = Math.round(width * scale);
      newHeight = Math.round(height * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = newWidth;
    canvas.height = newHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Failed to get 2d context"));
      return;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(img, 0, 0, newWidth, newHeight);

    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result);
        } else {
          reject(new Error("Canvas toBlob returned null"));
        }
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error("Failed to load image"));
  };

  img.src = url;
}
