export interface CameraOptions {
  facingMode?: "user" | "environment";
  width?: number;
  height?: number;
}

export async function getCameraStream(options: CameraOptions = {}): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    video: {
      facingMode: options.facingMode ?? "environment",
      width: { ideal: options.width ?? 1920 },
      height: { ideal: options.height ?? 1920 },
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
  quality: number = 0.8,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!video.videoWidth || !video.videoHeight) {
      reject(new Error("Video not ready"));
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Failed to get 2d context"));
      return;
    }
    ctx.drawImage(video, 0, 0);
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
