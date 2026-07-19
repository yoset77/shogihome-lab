import type {
  VisionPositionType,
  VisionScanResponse,
  VisionViewpoint,
} from "@/common/vision/types";

export type VisionEditSession = {
  sourceImage: Blob;
  response: VisionScanResponse;
  viewpoint: VisionViewpoint;
  positionType: VisionPositionType;
};
