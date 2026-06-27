import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCameraStream, stopCameraStream, captureVideoFrame } from "@/renderer/helpers/camera";

describe("renderer/helpers/camera", () => {
  const mockGetUserMedia = vi.fn();
  let originalMediaDevices: MediaDevices | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalMediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: mockGetUserMedia },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalMediaDevices !== undefined) {
      Object.defineProperty(navigator, "mediaDevices", {
        value: originalMediaDevices,
        writable: true,
        configurable: true,
      });
    }
  });

  describe("getCameraStream", () => {
    it("calls getUserMedia with default environment-facing constraints", async () => {
      const mockStream = { getTracks: vi.fn(() => []) } as unknown as MediaStream;
      mockGetUserMedia.mockResolvedValue(mockStream);

      const result = await getCameraStream();

      expect(result).toBe(mockStream);
      expect(mockGetUserMedia).toHaveBeenCalledWith({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
      });
    });

    it("passes custom options", async () => {
      const mockStream = { getTracks: vi.fn(() => []) } as unknown as MediaStream;
      mockGetUserMedia.mockResolvedValue(mockStream);

      await getCameraStream({ facingMode: "user", width: 1280, height: 720 });

      expect(mockGetUserMedia).toHaveBeenCalledWith({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
    });

    it("propagates permission denied errors", async () => {
      mockGetUserMedia.mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));

      await expect(getCameraStream()).rejects.toThrow("Permission denied");
    });
  });

  describe("stopCameraStream", () => {
    it("stops all tracks in the stream", () => {
      const mockTrack1 = { stop: vi.fn() };
      const mockTrack2 = { stop: vi.fn() };
      const stream = {
        getTracks: vi.fn(() => [mockTrack1, mockTrack2]),
      } as unknown as MediaStream;

      stopCameraStream(stream);

      expect(mockTrack1.stop).toHaveBeenCalled();
      expect(mockTrack2.stop).toHaveBeenCalled();
    });
  });

  describe("captureVideoFrame", () => {
    it("rejects when video is not ready (zero dimensions)", async () => {
      const video = {
        videoWidth: 0,
        videoHeight: 0,
      } as unknown as HTMLVideoElement;

      await expect(captureVideoFrame(video)).rejects.toThrow("Video not ready");
    });

    it("draws video frame to canvas and returns JPEG blob", async () => {
      const mockCtx = {
        drawImage: vi.fn(),
      };
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
        toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
          callback(new Blob(["frame"], { type: "image/jpeg" }));
        }),
      };

      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return mockCanvas as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      const video = {
        videoWidth: 1920,
        videoHeight: 1080,
      } as unknown as HTMLVideoElement;

      const result = await captureVideoFrame(video);

      expect(mockCanvas.width).toBe(1707);
      expect(mockCanvas.height).toBe(960);
      expect(mockCtx.drawImage).toHaveBeenCalledWith(video, 0, 0, 1707, 960);
      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.9);
      expect(result.type).toBe("image/jpeg");

      vi.restoreAllMocks();
    });

    it("uses custom mimeType and quality", async () => {
      const mockCtx = {
        drawImage: vi.fn(),
      };
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
        toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
          callback(new Blob(["frame"], { type: "image/webp" }));
        }),
      };

      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return mockCanvas as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      const video = {
        videoWidth: 1280,
        videoHeight: 720,
      } as unknown as HTMLVideoElement;

      const result = await captureVideoFrame(video, "image/webp", 0.9);

      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.9);
      expect(result.type).toBe("image/webp");

      vi.restoreAllMocks();
    });

    it("rejects when toBlob returns null", async () => {
      const mockCtx = {
        drawImage: vi.fn(),
      };
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => mockCtx),
        toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
          callback(null);
        }),
      };

      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return mockCanvas as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      const video = {
        videoWidth: 640,
        videoHeight: 480,
      } as unknown as HTMLVideoElement;

      await expect(captureVideoFrame(video)).rejects.toThrow("Canvas toBlob returned null");

      vi.restoreAllMocks();
    });

    it("rejects when canvas context is unavailable", async () => {
      const mockCanvas = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => null),
        toBlob: vi.fn(),
      };

      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        if (tagName === "canvas") {
          return mockCanvas as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tagName);
      });

      const video = {
        videoWidth: 640,
        videoHeight: 480,
      } as unknown as HTMLVideoElement;

      await expect(captureVideoFrame(video)).rejects.toThrow("Failed to get 2d context");

      vi.restoreAllMocks();
    });
  });
});
