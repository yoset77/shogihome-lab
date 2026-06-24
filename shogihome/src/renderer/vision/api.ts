import type { VisionScanResponse, VisionTurn, VisionViewpoint } from "@/common/vision/types";

export async function scanPositionImage(
  image: Blob,
  sideToMove: VisionTurn,
  viewpoint: VisionViewpoint,
  signal?: AbortSignal,
): Promise<VisionScanResponse> {
  const contentType = normalizeImageType(image.type);
  const params = new URLSearchParams({
    sideToMove,
    viewpoint,
    maxCandidates: "5",
  });
  const response = await fetch(`/api/vision/scan?${params.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
    },
    body: image,
    signal,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return (await response.json()) as VisionScanResponse;
}

function normalizeImageType(type: string): string {
  if (type === "image/jpeg" || type === "image/png") {
    return type;
  }
  return "image/jpeg";
}
