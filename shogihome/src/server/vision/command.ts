import type { VisionScanResponse, VisionTurn, VisionViewpoint } from "@/common/vision/types";
import { writeTempVisionImage } from "@/server/vision/temp";
import { transformVisionResponse } from "@/server/vision/transform";
import { visionWorkerClient } from "@/server/vision/worker";

export type VisionScanOptions = {
  image: Buffer;
  extension: string;
  sideToMove: VisionTurn;
  viewpoint: VisionViewpoint;
  maxCandidates: number;
};

export const scanPositionImage = async (
  options: VisionScanOptions,
): Promise<VisionScanResponse> => {
  const temp = await writeTempVisionImage(options.image, options.extension);

  try {
    const response = await visionWorkerClient.scan({
      type: "scan",
      imagePath: temp.imagePath,
      sideToMove: options.sideToMove,
      maxCandidates: options.maxCandidates,
    });
    return transformVisionResponse(response, options.sideToMove, options.viewpoint);
  } finally {
    await temp.cleanup().catch((error: unknown) => {
      console.warn("failed to clean up vision temp file:", error);
    });
  }
};
