export interface CameraOptions {
  facingMode?: "user" | "environment";
  width?: number;
  height?: number;
}

const DEFAULT_CAMERA_WIDTH = 1280;
const DEFAULT_CAMERA_HEIGHT = 1280;
const CAPTURE_TARGET_SHORT_SIDE = 960;

export async function getCameraStream(options: CameraOptions = {}): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    video: {
      facingMode: options.facingMode ?? "environment",
      width: { ideal: options.width ?? DEFAULT_CAMERA_WIDTH },
      height: { ideal: options.height ?? DEFAULT_CAMERA_HEIGHT },
    },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

export function stopCameraStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

export function captureVideoFrame(
  video: HTMLVideoElement,
  mimeType: string = "image/jpeg",
  quality: number = 0.9,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!video.videoWidth || !video.videoHeight) {
      reject(new Error("Video not ready"));
      return;
    }
    const { width, height } = fitWithinShortSide(
      video.videoWidth,
      video.videoHeight,
      CAPTURE_TARGET_SHORT_SIDE,
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Failed to get 2d context"));
      return;
    }
    ctx.drawImage(video, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Canvas toBlob returned null"));
        }
      },
      mimeType,
      quality,
    );
  });
}

const fitWithinShortSide = (
  width: number,
  height: number,
  targetShortSide: number,
): { width: number; height: number } => {
  const shortSide = Math.min(width, height);
  if (shortSide <= targetShortSide) {
    return { width, height };
  }
  const scale = targetShortSide / shortSide;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
};
